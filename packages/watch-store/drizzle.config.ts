import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/schema.ts',
  out: './drizzle',
  // admin-store and ban-store migrate the same database. A distinct tracking table keeps
  // this journal from fighting their "__drizzle_migrations" rows.
  migrations: { table: 'watch_store_migrations' },
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://cod2admin:dev_password_change_me@127.0.0.1:5432/cod2admin_dev',
  },
});
