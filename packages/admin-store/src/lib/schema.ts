import { sql } from 'drizzle-orm';
import { bigint, jsonb, pgEnum, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const adminRoleEnum = pgEnum('admin_role', ['owner', 'admin', 'moderator']);
export const auditSourceEnum = pgEnum('audit_source', ['telegram_button', 'telegram_command', 'auto']);

/** docs/PLAN.md §4/§7 — one row per Telegram admin. At most one `owner` row, ever. */
export const admins = pgTable(
  'admins',
  {
    telegramId: bigint('telegram_id', { mode: 'number' }).primaryKey(),
    role: adminRoleEnum('role').notNull(),
    addedBy: bigint('added_by', { mode: 'number' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Race-safe "at most one owner" per §4 — a DB-level partial unique index, not just an
    // application check-then-insert, so two people racing /claim can't both succeed.
    uniqueIndex('admins_one_owner_idx').on(table.role).where(sql`${table.role} = 'owner'`),
  ],
);

/** docs/PLAN.md §4 — per-server access scoping. No rows for an admin ⇒ access to all servers. */
export const adminServers = pgTable(
  'admin_servers',
  {
    telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
    serverAlias: text('server_alias').notNull(),
  },
  (table) => [primaryKey({ columns: [table.telegramId, table.serverAlias] })],
);

/** docs/PLAN.md §7. `rconPasswordEncrypted` is opaque here — see `secrets.ts` for the codec. */
export const servers = pgTable('servers', {
  alias: text('alias').primaryKey(),
  rconHost: text('rcon_host').notNull(),
  rconPort: bigint('rcon_port', { mode: 'number' }).notNull(),
  rconPasswordEncrypted: text('rcon_password_encrypted').notNull(),
  logSourceConfig: text('log_source_config'),
  boundTelegramChatId: bigint('bound_telegram_chat_id', { mode: 'number' }),
});

/** docs/PLAN.md §4/§7 — every privileged action, reviewable via `/auditlog`. */
export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  actorTelegramId: bigint('actor_telegram_id', { mode: 'number' }).notNull(),
  action: text('action').notNull(),
  target: text('target'),
  serverAlias: text('server_alias'),
  reason: text('reason'),
  source: auditSourceEnum('source').notNull(),
  detailJson: jsonb('detail_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
