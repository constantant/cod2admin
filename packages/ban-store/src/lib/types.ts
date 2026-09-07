export interface Ban {
  id: number;
  serverAlias: string;
  guid: string | null;
  name: string;
  reason: string | null;
  bannedBy: number;
  bannedAt: Date;
  expiresAt: Date | null;
  /** Set once `/unban <guid>` has explicitly lifted this ban — `null` means still in effect. */
  unbannedAt: Date | null;
}

export interface RecordBanInput {
  serverAlias: string;
  name: string;
  /** The banned client's GUID, if known — undefined/omitted inserts `null` (docs/PLAN.md §2.4/§5 step 6). */
  guid?: string | null;
  reason?: string | null;
  bannedBy: number;
  /** Set for the report card's `Temp Ban` button (§5 step 6); omitted/null for a permanent `/ban`. */
  expiresAt?: Date | null;
}

export interface BanIp {
  id: number;
  serverAlias: string;
  ip: string;
  reason: string | null;
  bannedBy: number;
  bannedAt: Date;
  expiresAt: Date | null;
  /** Set once `/unban <ip>` has explicitly lifted this ban — `null` means still in effect. */
  unbannedAt: Date | null;
}

export interface RecordIpBanInput {
  serverAlias: string;
  ip: string;
  reason?: string | null;
  bannedBy: number;
  /** Null for a permanent IP ban (docs/PLAN.md §7 — ban_ips supports both). */
  expiresAt: Date | null;
}

/**
 * Thin repository over Postgres (docs/PLAN.md §3.1/§7). `bans` is GUID-based/permanent-only in
 * Phase 2 (see `schema.ts`); `ban_ips` is what `/tempban` actually uses, enforced by `poller.ts`.
 */
export interface BanStore {
  recordBan(input: RecordBanInput): Promise<void>;

  recordIpBan(input: RecordIpBanInput): Promise<void>;
  /** Rows with `expiresAt` null or in the future, and not yet unbanned — what the poller should currently enforce. */
  listActiveIpBans(serverAlias: string): Promise<BanIp[]>;
  listExpiredIpBans(serverAlias: string, now: Date): Promise<BanIp[]>;
  expireIpBan(id: number): Promise<void>;
  /** `/unban <ip>` (docs/PLAN.md §6): stamps `unbannedAt` on matching active `ban_ips` rows — never written to ban.txt, so no rcon call is needed. */
  unbanIp(serverAlias: string, ip: string): Promise<void>;

  /**
   * GUID-path temp bans whose `expiresAt` has passed (docs/PLAN.md §5 step 7's poller job (b)) —
   * the `bans`-table equivalent of `listExpiredIpBans`. Unlike an IP ban, reversing this needs an
   * rcon call (`unbanUser(guid)`, to remove the ban.txt entry) before the row is dropped — that's
   * why this returns full `Ban` rows (for their `guid`), not just IDs.
   */
  listExpiredBans(serverAlias: string, now: Date): Promise<Ban[]>;
  expireBan(id: number): Promise<void>;
  /** Rows with `expiresAt` null or in the future, and not yet unbanned — the `bans`-table equivalent of `listActiveIpBans`, for `/bans`. */
  listActiveBans(serverAlias: string): Promise<Ban[]>;
  /** `/unban <guid>` (docs/PLAN.md §6): stamps `unbannedAt` on matching active `bans` rows so `/bans` stops listing them, alongside the caller's own `unbanUser(guid)` rcon call. */
  unbanByGuid(serverAlias: string, guid: string): Promise<void>;

  /**
   * Prior GUID-path bans against a specific GUID (docs/PLAN.md §5 step 3's report enrichment),
   * newest first.
   */
  listBansByGuid(serverAlias: string, guid: string, limit: number): Promise<Ban[]>;
  /** Fallback for the common GUID-0 case (§2.4), or today, the only case that ever matches. */
  listBansByName(serverAlias: string, name: string, limit: number): Promise<Ban[]>;
  /** IP-ban history — `bans` has no IP column, so IP-based history only ever comes from here. */
  listIpBansByIp(serverAlias: string, ip: string, limit: number): Promise<BanIp[]>;

  close(): Promise<void>;
}
