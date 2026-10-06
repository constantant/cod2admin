export interface Ban {
  id: number;
  /** The server the ban was issued on. The ban itself applies to every server (see `BanStore`). */
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
  /** The server the ban was issued on. The ban itself applies to every server (see `BanStore`). */
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
 * Thin repository over Postgres (docs/PLAN.md §3.1/§7). `bans` is the GUID path, `ban_ips` the IP
 * path (GUID-0 players and every `/tempban`), both enforced by `poller.ts`.
 *
 * Bans are global: every read and unban below covers all servers. A row's `serverAlias` only
 * records where the ban was issued (and so which server's `ban.txt` holds a GUID ban).
 */
export interface BanStore {
  recordBan(input: RecordBanInput): Promise<void>;

  recordIpBan(input: RecordIpBanInput): Promise<void>;
  /** Rows with `expiresAt` null or in the future, and not yet unbanned — what the poller should currently enforce. */
  listActiveIpBans(): Promise<BanIp[]>;
  listExpiredIpBans(now: Date): Promise<BanIp[]>;
  expireIpBan(id: number): Promise<void>;
  /**
   * `/unban <ip>` (docs/PLAN.md §6): stamps `unbannedAt` on matching active `ban_ips` rows — never
   * written to ban.txt, so no rcon call is needed. Returns how many active bans were lifted.
   */
  unbanIp(ip: string): Promise<number>;

  /**
   * GUID-path temp bans whose `expiresAt` has passed (docs/PLAN.md §5 step 7's poller job (b)) —
   * the `bans`-table equivalent of `listExpiredIpBans`. Temp bans are never in `ban.txt`, so
   * dropping the row is all it takes to lift one.
   */
  listExpiredBans(now: Date): Promise<Ban[]>;
  expireBan(id: number): Promise<void>;
  /** Rows with `expiresAt` null or in the future, and not yet unbanned — the `bans`-table equivalent of `listActiveIpBans`, for `/bans` and the poller. */
  listActiveBans(): Promise<Ban[]>;
  /**
   * `/unban <guid>` (docs/PLAN.md §6): stamps `unbannedAt` on matching active `bans` rows so
   * they stop being enforced, and returns the rows it lifted. The caller needs their `name` and
   * `serverAlias` to remove a permanent ban from that server's `ban.txt` too: `unbanUser` matches
   * by name, not GUID (§2.4 "ban.txt").
   */
  unbanByGuid(guid: string): Promise<Ban[]>;

  /**
   * Prior GUID-path bans against a specific GUID, on any server (docs/PLAN.md §5 step 3's report
   * enrichment), newest first.
   */
  listBansByGuid(guid: string, limit: number): Promise<Ban[]>;
  /** Fallback for the common GUID-0 case (§2.4), or today, the only case that ever matches. */
  listBansByName(name: string, limit: number): Promise<Ban[]>;
  /** IP-ban history — `bans` has no IP column, so IP-based history only ever comes from here. */
  listIpBansByIp(ip: string, limit: number): Promise<BanIp[]>;

  close(): Promise<void>;
}
