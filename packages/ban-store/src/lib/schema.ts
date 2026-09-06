import { bigint, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * GUID-based bans (docs/PLAN.md §7). `guid` is nullable: as of Phase 2, `recordBan`'s input has
 * no `guid` field and the store always inserts `null` — Phase 2-era research assumed no rcon
 * command ever exposes a connected player's GUID (only log-tailing does). Phase 3 (§2.4) found
 * that's not universally true — this target server's `status()` does return `guid` — so
 * `/ban`'s command handler could pass a real one now; it just hasn't been updated to. Until it
 * is, every row here has `guid: null` regardless of what `status()` could have provided.
 * Populated only by `/ban` (permanent — `expiresAt: null`); never by `/tempban`, which is
 * IP-only in Phase 2 (see `poller.ts` and the Phase 2 plan's "tempban mechanism" decision).
 */
export const bans = pgTable('bans', {
  id: serial('id').primaryKey(),
  serverAlias: text('server_alias').notNull(),
  guid: text('guid'),
  name: text('name').notNull(),
  reason: text('reason'),
  bannedBy: bigint('banned_by', { mode: 'number' }).notNull(),
  bannedAt: timestamp('banned_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

/**
 * IP-based bans (docs/PLAN.md §7) — the *only* mechanism `/tempban` uses in Phase 2. Enforced
 * purely by the gateway's poller (kick-on-sight + row expiry); no native rcon "unban" call is ever
 * needed since these were never written to ban.txt in the first place.
 */
export const banIps = pgTable('ban_ips', {
  id: serial('id').primaryKey(),
  serverAlias: text('server_alias').notNull(),
  ip: text('ip').notNull(),
  reason: text('reason'),
  bannedBy: bigint('banned_by', { mode: 'number' }).notNull(),
  bannedAt: timestamp('banned_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});
