import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/schema.ts',
  out: './drizzle',
  // ban-store migrates the same physical database independently — without a distinct tracking
  // table both packages fight over the default "drizzle"."__drizzle_migrations" table.
  migrations: { table: 'admin_store_migrations' },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://cod2admin:dev_password_change_me@127.0.0.1:5432/cod2admin_dev',
  },
});
