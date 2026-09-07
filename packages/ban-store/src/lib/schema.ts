import { bigint, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * GUID-based bans (docs/PLAN.md §7). `guid` is nullable: a GUID-0 target (§2.4's confirmed-common
 * case) has none to record, and `recordBan`'s caller passes `undefined`/`null` for it — this
 * table is the GUID *path*, used only when a real GUID is available; a GUID-0 target's ban goes
 * to `ban_ips` instead (§5 step 7's fallback). `expiresAt` is set by the report card's
 * `Temp Ban` button (§5 step 6 — it deliberately doesn't use native `tempBanClient`, see that
 * section) and left `null` by a permanent `/ban`/`Ban` button; `poller.ts`'s `runBanExpirySweep`
 * (added alongside `Temp Ban`) calls `unbanUser(guid)` once a temp entry's `expiresAt` passes.
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
  /** Set by `/unban <ip>` (via `unbanIp`) once explicitly lifted — same purpose as `bans.unbannedAt`. */
  unbannedAt: timestamp('unbanned_at', { withTimezone: true }),
});
