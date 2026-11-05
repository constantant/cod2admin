import { bigint, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * GUID-based bans (docs/PLAN.md §7). `guid` is nullable: a GUID-0 target (§2.4's confirmed-common
 * case) has none to record, and `recordBan`'s caller passes `undefined`/`null` for it — this
 * table is the GUID *path*, used only when a real GUID is available; a GUID-0 target's ban goes
 * to `ban_ips` instead (§5 step 7's fallback). `expiresAt` is set by the report card's
 * `Temp Ban` button (§5 step 6 — it deliberately doesn't use native `tempBanClient`, see that
 * section) and left `null` by a permanent `/ban`/`Ban` button; `poller.ts`'s `runBanExpirySweep`
 * drops a temp entry once its `expiresAt` passes.
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
  /**
   * Set by `/unban` (via `unbanByGuid`) once the row's target has been explicitly unbanned —
   * `null` means still in effect. Kept distinct from deleting the row so ban-history lookups
   * (`listBansByGuid`/`listBansByName`) still show it; only `listActiveBans`/`listExpiredBans`
   * filter it out.
   */
  unbannedAt: timestamp('unbanned_at', { withTimezone: true }),
});

/**
 * Chat mutes (issue #7). CoD2 can't stop a player's message reaching the chat, so the gateway enforces
 * these from the log (apps/gateway/src/lib/mute-enforcer.ts): a warning, then kicks. Like bans they
 * apply on every server, and `serverAlias` only records where one was issued.
 */
export const mutes = pgTable('mutes', {
  id: serial('id').primaryKey(),
  serverAlias: text('server_alias').notNull(),
  name: text('name').notNull(),
  guid: text('guid'),
  ip: text('ip'),
  reason: text('reason'),
  mutedBy: bigint('muted_by', { mode: 'number' }).notNull(),
  mutedAt: timestamp('muted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  unmutedAt: timestamp('unmuted_at', { withTimezone: true }),
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
  /** The player's name when banned. Null for a manual ban of a bare IP, and for bans older than this column. */
  name: text('name'),
  reason: text('reason'),
  bannedBy: bigint('banned_by', { mode: 'number' }).notNull(),
  bannedAt: timestamp('banned_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** Set by `/unban <ip>` (via `unbanIp`) once explicitly lifted — same purpose as `bans.unbannedAt`. */
  unbannedAt: timestamp('unbanned_at', { withTimezone: true }),
});
