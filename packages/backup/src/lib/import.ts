import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { Pool, PoolClient } from 'pg';
import { decryptStream } from './crypto.js';
import {
  cascadeClosure,
  foreignKeys,
  isJsonType,
  listTables,
  orderByForeignKeys,
  quoteIdent,
  tableColumns,
  type ColumnInfo,
} from './db.js';
import {
  BACKUP_FORMAT,
  BackupError,
  type BackupLine,
  type EndLine,
  type Manifest,
  type ManifestTable,
  type SecretCodec,
} from './format.js';
import {
  EXCLUDED_TABLES,
  HOST_ROWS,
  SECRET_COLUMNS,
  tablesOfGroups,
  type BackupGroup,
} from './registry.js';

export interface RestoreOptions {
  pool: Pool;
  /** The `.c2bak` bytes. Single use: pass a fresh stream for the preview and for the apply. */
  source: AsyncIterable<Buffer>;
  passphrase: string;
  /** Needed whenever the file holds the `servers` table. */
  secrets?: SecretCodec;
  /** Defaults to every group the file has. */
  groups?: readonly BackupGroup[];
  /** Check and report, write nothing. */
  dryRun?: boolean;
}

export interface TableReport {
  name: string;
  group: BackupGroup;
  fileRows: number;
  currentRows: number;
  /** File columns this database no longer has. Their values are dropped. */
  droppedColumns: string[];
}

export interface RestoreReport {
  applied: boolean;
  app: string;
  created: string;
  groups: BackupGroup[];
  tables: TableReport[];
  warnings: string[];
}

interface TablePlan {
  table: ManifestTable;
  /** Index in the file row → target column, or null when the column is dropped. */
  targets: (ColumnInfo | null)[];
  secretIndexes: Set<number>;
  insertColumns: string[];
  insertIndexes: number[];
  dropped: string[];
}

async function* readLines(
  source: AsyncIterable<Buffer>,
  passphrase: string,
): AsyncGenerator<BackupLine> {
  const gunzip = pipeline(
    Readable.from(decryptStream(source, passphrase)),
    createGunzip(),
    () => undefined,
  );
  const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try {
      yield JSON.parse(line) as BackupLine;
    } catch {
      throw new BackupError('The backup file is damaged (unreadable line).');
    }
  }
}

function validateManifest(line: BackupLine | undefined): Manifest {
  if (!line || line.t !== 'manifest') {
    throw new BackupError('The backup file has no manifest.');
  }
  if (line.format > BACKUP_FORMAT) {
    throw new BackupError(
      `The backup was made by a newer version (format ${line.format}); update the bot first.`,
    );
  }
  return line;
}

async function planTables(
  client: Pool | PoolClient,
  manifest: Manifest,
  groups: readonly BackupGroup[],
  warnings: string[],
): Promise<TablePlan[]> {
  const existing = await listTables(client);
  const allowed = new Set(tablesOfGroups(groups));
  const plans: TablePlan[] = [];
  for (const table of manifest.tables) {
    if (!allowed.has(table.name)) continue;
    if (!existing.has(table.name)) {
      warnings.push(
        `Table ${table.name} is in the file but not in this database; skipped.`,
      );
      continue;
    }
    const columns = await tableColumns(client, table.name);
    const byName = new Map(columns.map((column) => [column.name, column]));
    const secretNames = SECRET_COLUMNS[table.name] ?? [];
    const targets = table.columns.map((name) => byName.get(name) ?? null);
    const dropped = table.columns.filter((name) => !byName.has(name));
    if (dropped.length) {
      warnings.push(
        `Table ${table.name}: dropped columns this version no longer has (${dropped.join(', ')}).`,
      );
    }
    const inFile = new Set(table.columns);
    for (const column of columns) {
      if (!inFile.has(column.name) && !column.nullable && !column.hasDefault) {
        throw new BackupError(
          `Table ${table.name}: the file has no value for required column ${column.name}.`,
        );
      }
    }
    const insertIndexes = targets
      .map((target, index) => (target ? index : -1))
      .filter((index) => index >= 0);
    plans.push({
      table,
      targets,
      secretIndexes: new Set(
        table.columns
          .map((name, index) => (secretNames.includes(name) ? index : -1))
          .filter((index) => index >= 0),
      ),
      insertColumns: insertIndexes.map((index) => table.columns[index]),
      insertIndexes,
      dropped,
    });
  }
  return plans;
}

function ensureSecrets(plans: readonly TablePlan[], options: RestoreOptions) {
  if (!options.secrets && plans.some((plan) => plan.secretIndexes.size)) {
    throw new BackupError(
      'Restoring servers needs the secrets key (SECRETS_ENCRYPTION_KEY).',
    );
  }
}

async function countRows(
  client: Pool | PoolClient,
  table: string,
): Promise<number> {
  const host = HOST_ROWS[table];
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${quoteIdent(table)}` +
      (host ? ` WHERE NOT (${host})` : ''),
  );
  return Number(rows[0].n);
}

function rowParams(plan: TablePlan, row: unknown[], options: RestoreOptions) {
  return plan.insertIndexes.map((index) => {
    const value = row[index];
    if (value === null || value === undefined) return null;
    if (plan.secretIndexes.has(index) && typeof value === 'string') {
      return (options.secrets as SecretCodec).encrypt(value);
    }
    const target = plan.targets[index] as ColumnInfo;
    // `pg` turns a JS array into a Postgres array, which is wrong for a jsonb column.
    return isJsonType(target) ? JSON.stringify(value) : value;
  });
}

async function flushBatch(
  client: PoolClient,
  plan: TablePlan,
  batch: unknown[][],
): Promise<void> {
  if (!batch.length || !plan.insertColumns.length) return;
  const width = plan.insertColumns.length;
  const placeholders = batch
    .map(
      (_, rowIndex) =>
        `(${plan.insertColumns.map((__, col) => `$${rowIndex * width + col + 1}`).join(', ')})`,
    )
    .join(', ');
  const generated = plan.targets.some((target) => target?.generatedAlways);
  await client.query(
    `INSERT INTO ${quoteIdent(plan.table.name)} (${plan.insertColumns.map(quoteIdent).join(', ')})` +
      (generated ? ' OVERRIDING SYSTEM VALUE' : '') +
      ` VALUES ${placeholders}`,
    batch.flat() as unknown[],
  );
}

async function fixSequences(client: PoolClient, table: string): Promise<void> {
  const columns = await tableColumns(client, table);
  for (const column of columns) {
    const { rows } = await client.query<{ seq: string | null }>(
      `SELECT pg_get_serial_sequence($1, $2) AS seq`,
      [quoteIdent(table), column.name],
    );
    const seq = rows[0].seq;
    if (!seq) continue;
    const col = quoteIdent(column.name);
    await client.query(
      `SELECT setval($1, COALESCE((SELECT MAX(${col}) FROM ${quoteIdent(table)}), 1),
                         (SELECT MAX(${col}) IS NOT NULL FROM ${quoteIdent(table)}))`,
      [seq],
    );
  }
}

function checkCounts(
  end: EndLine | undefined,
  seen: Record<string, number>,
  names: readonly string[],
): void {
  if (!end) {
    throw new BackupError('The backup file is cut off (no end marker).');
  }
  for (const name of names) {
    if ((end.counts[name] ?? 0) !== (seen[name] ?? 0)) {
      throw new BackupError(
        `The backup file is damaged: ${name} has ${seen[name] ?? 0} rows, expected ${end.counts[name] ?? 0}.`,
      );
    }
  }
}

function report(
  manifest: Manifest,
  plans: readonly TablePlan[],
  seen: Record<string, number>,
  current: Record<string, number>,
  warnings: string[],
  applied: boolean,
): RestoreReport {
  return {
    applied,
    app: manifest.app,
    created: manifest.created,
    groups: manifest.groups,
    warnings,
    tables: plans.map((plan) => ({
      name: plan.table.name,
      group: plan.table.group,
      fileRows: seen[plan.table.name] ?? 0,
      currentRows: current[plan.table.name] ?? 0,
      droppedColumns: plan.dropped,
    })),
  };
}

const BATCH_PARAMS = 30000;

export async function restoreBackup(
  options: RestoreOptions,
): Promise<RestoreReport> {
  const lines = readLines(options.source, options.passphrase);
  const first = await lines.next();
  const manifest = validateManifest(first.done ? undefined : first.value);
  const warnings: string[] = [];
  const groups = (options.groups ?? manifest.groups).filter((group) =>
    manifest.groups.includes(group),
  );
  const plans = await planTables(options.pool, manifest, groups, warnings);
  ensureSecrets(plans, options);
  const names = plans.map((plan) => plan.table.name);
  const current: Record<string, number> = {};
  for (const name of names) current[name] = await countRows(options.pool, name);
  const planByName = new Map(plans.map((plan) => [plan.table.name, plan]));
  const seen: Record<string, number> = {};
  for (const name of names) seen[name] = 0;

  if (options.dryRun) {
    let end: EndLine | undefined;
    for await (const line of lines) {
      if (line.t === 'r' && planByName.has(line.n)) seen[line.n] += 1;
      else if (line.t === 'end') end = line;
    }
    checkCounts(end, seen, names);
    return report(manifest, plans, seen, current, warnings, false);
  }

  const keys = await foreignKeys(options.pool);
  const closure = cascadeClosure(names, keys);
  const collateral = [...closure].filter(
    (name) => !names.includes(name) && !EXCLUDED_TABLES.includes(name),
  );
  if (collateral.length) {
    throw new BackupError(
      `Replacing these tables would also empty ${collateral.join(', ')}; include those groups too.`,
    );
  }
  const insertOrder = orderByForeignKeys(names, keys);

  const client = await options.pool.connect();
  try {
    await client.query('BEGIN');
    // Hold off a second restore (or a scheduled export's lock) on the same database.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'cod2admin-backup',
    ]);
    const whole = insertOrder.filter((name) => !HOST_ROWS[name]);
    const partial = insertOrder.filter((name) => HOST_ROWS[name]);
    if (whole.length) {
      await client.query(
        `TRUNCATE ${whole.map(quoteIdent).join(', ')} RESTART IDENTITY CASCADE`,
      );
    }
    for (const name of partial) {
      await client.query(
        `DELETE FROM ${quoteIdent(name)} WHERE NOT (${HOST_ROWS[name]})`,
      );
    }

    let end: EndLine | undefined;
    let batchPlan: TablePlan | undefined;
    let batch: unknown[][] = [];
    const flush = async () => {
      if (batchPlan) await flushBatch(client, batchPlan, batch);
      batch = [];
    };
    for await (const line of lines) {
      if (line.t === 'end') {
        end = line;
        continue;
      }
      if (line.t !== 'r') continue;
      const plan = planByName.get(line.n);
      if (!plan) continue;
      if (plan !== batchPlan) {
        await flush();
        batchPlan = plan;
      }
      seen[line.n] += 1;
      batch.push(rowParams(plan, line.v, options));
      const size = Math.max(
        1,
        Math.min(
          500,
          Math.floor(BATCH_PARAMS / (plan.insertColumns.length || 1)),
        ),
      );
      if (batch.length >= size) await flush();
    }
    await flush();
    checkCounts(end, seen, names);
    for (const name of insertOrder) await fixSequences(client, name);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return report(manifest, plans, seen, current, warnings, true);
}
