import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pipeline as pipelineCb } from 'node:stream';
import type { Pool } from 'pg';
import { encryptStream, assertPassphrase } from './crypto.js';
import {
  foreignKeys,
  listTables,
  orderByForeignKeys,
  quoteIdent,
  selectExpression,
  tableColumns,
} from './db.js';
import {
  BACKUP_FORMAT,
  BackupError,
  type BackupLine,
  type Manifest,
  type SecretCodec,
} from './format.js';
import {
  HOST_ROWS,
  SECRET_COLUMNS,
  groupOfTable,
  tablesOfGroups,
  type BackupGroup,
} from './registry.js';

export interface ExportOptions {
  pool: Pool;
  groups: readonly BackupGroup[];
  passphrase: string;
  /** Needed whenever the `servers` table is exported. */
  secrets?: SecretCodec;
  appVersion: string;
  now?: () => Date;
}

export interface ExportResult {
  bytes: number;
  counts: Record<string, number>;
}

const FETCH_SIZE = 1000;

async function* backupLines(
  options: ExportOptions,
  counts: Record<string, number>,
): AsyncGenerator<string> {
  const client = await options.pool.connect();
  try {
    // One snapshot for every table, so rows that point at each other still match.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const existing = await listTables(client);
    const wanted = tablesOfGroups(options.groups).filter((name) =>
      existing.has(name),
    );
    const ordered = orderByForeignKeys(wanted, await foreignKeys(client));

    const plans = [];
    for (const name of ordered) {
      plans.push({ name, columns: await tableColumns(client, name) });
    }

    const manifest: Manifest = {
      t: 'manifest',
      format: BACKUP_FORMAT,
      app: options.appVersion,
      created: (options.now?.() ?? new Date()).toISOString(),
      groups: [...options.groups],
      tables: plans.map((plan) => ({
        name: plan.name,
        group: groupOfTable(plan.name) as BackupGroup,
        columns: plan.columns.map((column) => column.name),
      })),
    };
    yield `${JSON.stringify(manifest)}\n`;

    for (const plan of plans) {
      const secretNames = SECRET_COLUMNS[plan.name] ?? [];
      const secretIndexes = plan.columns
        .map((column, index) =>
          secretNames.includes(column.name) ? index : -1,
        )
        .filter((index) => index >= 0);
      if (secretIndexes.length && !options.secrets) {
        throw new BackupError(
          `Exporting ${plan.name} needs the secrets key (SECRETS_ENCRYPTION_KEY).`,
        );
      }
      const host = HOST_ROWS[plan.name];
      const sql =
        `SELECT ${plan.columns.map(selectExpression).join(', ')} ` +
        `FROM ${quoteIdent(plan.name)}` +
        (host ? ` WHERE NOT (${host})` : '');
      await client.query(`DECLARE backup_cur NO SCROLL CURSOR FOR ${sql}`);
      counts[plan.name] = 0;
      for (;;) {
        const { rows } = await client.query({
          text: `FETCH ${FETCH_SIZE} FROM backup_cur`,
          rowMode: 'array',
        });
        if (!rows.length) break;
        let out = '';
        for (const row of rows as unknown[][]) {
          for (const index of secretIndexes) {
            const value = row[index];
            if (typeof value === 'string') {
              row[index] = (options.secrets as SecretCodec).decrypt(value);
            }
          }
          const line: BackupLine = { t: 'r', n: plan.name, v: row };
          out += `${JSON.stringify(line)}\n`;
        }
        counts[plan.name] += rows.length;
        yield out;
      }
      await client.query('CLOSE backup_cur');
    }
    yield `${JSON.stringify({ t: 'end', counts } satisfies BackupLine)}\n`;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The encrypted `.c2bak` bytes. Nothing is read from the database until the first chunk is pulled. */
export function exportBackup(
  options: ExportOptions,
  counts: Record<string, number> = {},
): Readable {
  assertPassphrase(options.passphrase);
  const zipped = pipelineCb(
    Readable.from(backupLines(options, counts)),
    createGzip(),
    () => undefined,
  );
  return Readable.from(encryptStream(zipped, options.passphrase));
}

export async function exportBackupToFile(
  options: ExportOptions,
  path: string,
): Promise<ExportResult> {
  const counts: Record<string, number> = {};
  const output = createWriteStream(path, { mode: 0o600 });
  let bytes = 0;
  const source = exportBackup(options, counts);
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  await pipeline(source, output);
  return { bytes, counts };
}
