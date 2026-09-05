import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Applies pending migrations (generated via `pnpm --filter @cod2admin/admin-store db:generate`). */
export async function migrate(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER, migrationsTable: 'admin_store_migrations' });
  } finally {
    await pool.end();
  }
}
