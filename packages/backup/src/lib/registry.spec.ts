import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listTables } from './db.js';
import { EXCLUDED_TABLES, GROUP_TABLES } from './registry.js';
import { createScratchDb, type ScratchDb } from './testing-db.js';

describe('backup registry', () => {
  let db: ScratchDb;
  beforeAll(async () => {
    db = await createScratchDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('covers or deliberately excludes every table the migrations create', async () => {
    const covered = new Set([
      ...Object.values(GROUP_TABLES).flat(),
      ...EXCLUDED_TABLES,
    ]);
    const missing = [...(await listTables(db.pool))].filter(
      (name) => !covered.has(name),
    );
    expect(missing).toEqual([]);
  });

  it('lists no table the migrations do not create', async () => {
    const existing = await listTables(db.pool);
    const unknown = Object.values(GROUP_TABLES)
      .flat()
      .filter((name) => !existing.has(name));
    expect(unknown).toEqual([]);
  });
});
