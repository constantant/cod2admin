export interface Ban {
  id: number;
  serverAlias: string;
  guid: string | null;
  name: string;
  reason: string | null;
  bannedBy: number;
  bannedAt: Date;
  expiresAt: Date | null;
}

export interface RecordBanInput {
  serverAlias: string;
  name: string;
  reason?: string | null;
  bannedBy: number;
}

export interface BanIp {
  id: number;
  serverAlias: string;
  ip: string;
  reason: string | null;
  bannedBy: number;
  bannedAt: Date;
  expiresAt: Date | null;
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
  /** Rows with `expiresAt` null or in the future — what the poller should currently enforce. */
  listActiveIpBans(serverAlias: string): Promise<BanIp[]>;
  listExpiredIpBans(serverAlias: string, now: Date): Promise<BanIp[]>;
  expireIpBan(id: number): Promise<void>;

  /**
   * Prior GUID-path bans against a specific GUID (docs/PLAN.md §5 step 3's report enrichment),
   * newest first. Always empty today — `recordBan` has no `guid` input and always inserts
   * `null` (see `schema.ts`'s note); kept for when that's fixed, and so callers can write the
   * §2.4 correlation rule ("GUID unless it's 0") once, now, rather than after that fix lands.
   */
  listBansByGuid(serverAlias: string, guid: string, limit: number): Promise<Ban[]>;
  /** Fallback for the common GUID-0 case (§2.4), or today, the only case that ever matches. */
  listBansByName(serverAlias: string, name: string, limit: number): Promise<Ban[]>;
  /** IP-ban history — `bans` has no IP column, so IP-based history only ever comes from here. */
  listIpBansByIp(serverAlias: string, ip: string, limit: number): Promise<BanIp[]>;

  close(): Promise<void>;
}
