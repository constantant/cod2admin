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

  close(): Promise<void>;
}
