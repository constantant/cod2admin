import type { Pool, PoolClient } from 'pg';

export type Queryable = Pool | PoolClient;

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
  generatedAlways: boolean;
}

export const quoteIdent = (name: string): string =>
  `"${name.replace(/"/g, '""')}"`;

/** Base tables in `public`. */
export async function listTables(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  return new Set(rows.map((row) => row.table_name));
}

export async function tableColumns(
  db: Queryable,
  table: string,
): Promise<ColumnInfo[]> {
  const { rows } = await db.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    is_generated: string;
    identity_generation: string | null;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default, is_generated, identity_generation
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => ({
    name: row.column_name,
    dataType: row.data_type,
    nullable: row.is_nullable === 'YES',
    hasDefault: row.column_default !== null || row.identity_generation !== null,
    generatedAlways:
      row.is_generated === 'ALWAYS' || row.identity_generation === 'ALWAYS',
  }));
}

export interface ForeignKey {
  child: string;
  parent: string;
}

export async function foreignKeys(db: Queryable): Promise<ForeignKey[]> {
  const { rows } = await db.query<ForeignKey>(
    `SELECT cl.relname AS child, pl.relname AS parent
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_class pl ON pl.oid = c.confrelid
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
  );
  return rows.filter((row) => row.child !== row.parent);
}

/** Parents before children; `names` order breaks ties. Foreign keys to tables outside `names` are ignored. */
export function orderByForeignKeys(
  names: readonly string[],
  keys: readonly ForeignKey[],
): string[] {
  const inSet = new Set(names);
  const done = new Set<string>();
  const out: string[] = [];
  const visit = (name: string, trail: Set<string>): void => {
    if (done.has(name) || trail.has(name)) return;
    trail.add(name);
    for (const key of keys) {
      if (key.child === name && inSet.has(key.parent)) {
        visit(key.parent, trail);
      }
    }
    trail.delete(name);
    done.add(name);
    out.push(name);
  };
  for (const name of names) visit(name, new Set());
  return out;
}

/** Every table that `TRUNCATE ... CASCADE` of `roots` would also empty. */
export function cascadeClosure(
  roots: readonly string[],
  keys: readonly ForeignKey[],
): Set<string> {
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const current = queue.pop() as string;
    for (const key of keys) {
      if (key.parent === current && !seen.has(key.child)) {
        seen.add(key.child);
        queue.push(key.child);
      }
    }
  }
  return seen;
}

/** Types whose JS value survives JSON unchanged; everything else is moved as text. */
const NATIVE_TYPES = new Set([
  'text',
  'character varying',
  'integer',
  'smallint',
  'bigint',
  'boolean',
  'json',
  'jsonb',
  'uuid',
  'USER-DEFINED',
]);

export function selectExpression(column: ColumnInfo): string {
  const name = quoteIdent(column.name);
  return NATIVE_TYPES.has(column.dataType) ? name : `${name}::text`;
}

export const isJsonType = (column: ColumnInfo): boolean =>
  column.dataType === 'json' || column.dataType === 'jsonb';
