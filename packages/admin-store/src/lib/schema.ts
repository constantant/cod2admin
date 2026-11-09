import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const auditSourceEnum = pgEnum('audit_source', [
  'telegram_button',
  'telegram_command',
  'auto',
  'miniapp',
  'mcp',
]);

export const reportStatusEnum = pgEnum('report_status', [
  'open',
  'handled',
  'ignored',
]);
export const noteKindEnum = pgEnum('player_note_kind', ['guid', 'ip', 'name']);

/** docs/PLAN.md §4/§7 — one row per Telegram admin. At most one owner, ever. */
export const admins = pgTable(
  'admins',
  {
    telegramId: bigint('telegram_id', { mode: 'number' }).primaryKey(),
    /** The bootstrap account. Implies every permission, and cannot be edited. */
    isOwner: boolean('is_owner').notNull().default(false),
    addedBy: bigint('added_by', { mode: 'number' }),
    addedAt: timestamp('added_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Race-safe "at most one owner" — a DB-level partial unique index, not just an
    // application check-then-insert, so two people racing /claim can't both succeed.
    uniqueIndex('admins_one_owner_idx')
      .on(table.isOwner)
      .where(sql`${table.isOwner} = true`),
  ],
);

/** Permissions granted to a non-owner. The owner has none of these rows; `is_owner` covers them. */
export const adminPermissions = pgTable(
  'admin_permissions',
  {
    telegramId: bigint('telegram_id', { mode: 'number' })
      .notNull()
      .references(() => admins.telegramId, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.telegramId, table.permission] }),
  ],
);

/**
 * Last-seen Telegram @username/first name per user, so `/auditlog` and `/listadmins` can show
 * names instead of bare IDs. Kept apart from `admins` so names survive `/removeadmin` — the audit
 * log still has to name a removed admin. Refreshed whenever an admin uses the bot (auth.ts).
 */
export const telegramUsers = pgTable('telegram_users', {
  telegramId: bigint('telegram_id', { mode: 'number' }).primaryKey(),
  username: text('username'),
  firstName: text('first_name'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
export const servers = pgTable(
  'servers',
  {
    alias: text('alias').primaryKey(),
    rconHost: text('rcon_host').notNull(),
    rconPort: bigint('rcon_port', { mode: 'number' }).notNull(),
    rconPasswordEncrypted: text('rcon_password_encrypted').notNull(),
    logSourceConfig: text('log_source_config'),
    boundTelegramChatId: bigint('bound_telegram_chat_id', { mode: 'number' }),
    /** Target of commands without `--server` in chats not bound via `/bindserver` (`/setdefault`). */
    isDefault: boolean('is_default').notNull().default(false),
  },
  (table) => [
    // At most one default server, enforced by the DB like admins_one_owner_idx.
    uniqueIndex('servers_one_default_idx')
      .on(table.isDefault)
      .where(sql`${table.isDefault}`),
  ],
);

/**
 * Settings the owner changes from Telegram (e.g. `/relays`), overriding the `.env` defaults. One
 * row per key, value as JSON — the shape belongs to whichever feature owns the key.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * An OAuth authorization request waiting for the staff member to approve it in Telegram.
 * The browser and Telegram each hold a different secret; only the hashes are stored.
 */
export const mcpPending = pgTable('mcp_pending', {
  publicId: text('public_id').primaryKey(),
  approveHash: text('approve_hash').notNull().unique(),
  browserHash: text('browser_hash').notNull().unique(),
  clientId: text('client_id').notNull(),
  clientName: text('client_name').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  resource: text('resource').notNull(),
  scope: text('scope').notNull(),
  state: text('state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  telegramId: bigint('telegram_id', { mode: 'number' }),
  permissions: text('permissions').array(),
  decision: text('decision'),
  codeIssued: boolean('code_issued').notNull().default(false),
});

/** A single-use authorization code. Reuse revokes the grant it already created. */
export const mcpCodes = pgTable('mcp_codes', {
  codeHash: text('code_hash').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' })
    .notNull()
    .references(() => admins.telegramId, { onDelete: 'cascade' }),
  permissions: text('permissions').array().notNull(),
  clientId: text('client_id').notNull(),
  clientName: text('client_name').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  resource: text('resource').notNull(),
  scope: text('scope').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedGrantId: text('used_grant_id'),
});

/** One AI connection. Refresh tokens rotate; presenting an old one revokes the row. */
export const mcpGrants = pgTable(
  'mcp_grants',
  {
    id: text('id').primaryKey(),
    telegramId: bigint('telegram_id', { mode: 'number' })
      .notNull()
      .references(() => admins.telegramId, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    clientName: text('client_name').notNull(),
    redirectHost: text('redirect_host').notNull(),
    permissions: text('permissions').array().notNull(),
    scope: text('scope').notNull(),
    resource: text('resource').notNull(),
    refreshHash: text('refresh_hash').notNull().unique(),
    refreshExpiresAt: timestamp('refresh_expires_at', {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('mcp_grants_telegram_idx').on(table.telegramId)],
);

/** Refresh-token hashes that already rotated. Presenting one revokes its grant. */
export const mcpRetiredRefresh = pgTable('mcp_retired_refresh', {
  refreshHash: text('refresh_hash').primaryKey(),
  grantId: text('grant_id')
    .notNull()
    .references(() => mcpGrants.id, { onDelete: 'cascade' }),
});

/** Short-lived access tokens. Deleting the grant (or the admin) removes them. */
export const mcpAccess = pgTable('mcp_access', {
  tokenHash: text('token_hash').primaryKey(),
  grantId: text('grant_id')
    .notNull()
    .references(() => mcpGrants.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
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
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Every `!report` players file (docs/PLAN-miniapp.md §6.4) — the Mini App's queue. Repeats of an
 * open report collapse into one row (`count`), like the Telegram card does.
 */
export const reports = pgTable(
  'reports',
  {
    id: serial('id').primaryKey(),
    serverAlias: text('server_alias').notNull(),
    reporterName: text('reporter_name').notNull(),
    reporterGuid: text('reporter_guid'),
    targetName: text('target_name').notNull(),
    reason: text('reason'),
    status: reportStatusEnum('status').notNull().default('open'),
    count: integer('count').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastReportedAt: timestamp('last_reported_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedBy: bigint('resolved_by', { mode: 'number' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** What was done, e.g. `Kicked`. */
    outcome: text('outcome'),
  },
  (table) => [
    index('reports_status_idx').on(table.status, table.lastReportedAt),
  ],
);

/**
 * Free-text notes on a player, separate from bans (docs/PLAN-miniapp.md §6.4). `value` is a GUID,
 * an IP, or a name in lower case without colour codes. `watch` puts them on the watchlist.
 */
export const playerNotes = pgTable(
  'player_notes',
  {
    id: serial('id').primaryKey(),
    kind: noteKindEnum('kind').notNull(),
    value: text('value').notNull(),
    note: text('note').notNull(),
    watch: boolean('watch').notNull().default(false),
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('player_notes_value_idx').on(table.kind, table.value)],
);

/** One public `getstatus` per server per minute — the dashboard's history (§6.4). */
export const serverSnapshots = pgTable(
  'server_snapshots',
  {
    id: serial('id').primaryKey(),
    serverAlias: text('server_alias').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** `false`: the server didn't answer, so the other fields say nothing. */
    online: boolean('online').notNull(),
    playerCount: integer('player_count').notNull().default(0),
    maxClients: integer('max_clients'),
    map: text('map'),
    gametype: text('gametype'),
  },
  (table) => [
    index('server_snapshots_alias_at_idx').on(table.serverAlias, table.at),
  ],
);

/**
 * Known players (docs/PLAN-known-players.md): a name and the provider networks (ASNs) it normally
 * connects from. `name` is lower case without colour codes; `display` is how the admin typed it.
 */
export const knownPlayers = pgTable('known_players', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  display: text('display').notNull(),
  asns: bigint('asns', { mode: 'number' }).array().notNull(),
  /** Real GUIDs (never 0) the player has been seen with — stronger than an ASN when present. */
  guids: text('guids').array().notNull().default(sql`'{}'::text[]`),
  note: text('note'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
