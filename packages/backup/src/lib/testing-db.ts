import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { migrate as migrateAdmin } from '@cod2admin/admin-store';
import { migrate as migrateBan } from '@cod2admin/ban-store';
import { migrate as migrateWatch } from '@cod2admin/watch-store';

const BASE_URL =
  process.env.DATABASE_URL ??
  'postgres://cod2admin:dev_password_change_me@127.0.0.1:5432/cod2admin_dev';

export interface ScratchDb {
  url: string;
  pool: Pool;
  drop(): Promise<void>;
}

/** A throwaway, fully migrated database, so tests never touch the shared dev data. */
export async function createScratchDb(): Promise<ScratchDb> {
  const name = `c2bak_test_${randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: BASE_URL });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(BASE_URL);
  url.pathname = `/${name}`;
  await migrateAdmin(url.toString());
  await migrateBan(url.toString());
  await migrateWatch(url.toString());
  const pool = new Pool({ connectionString: url.toString() });
  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
