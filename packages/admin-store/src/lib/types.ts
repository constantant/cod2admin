export type AdminRole = 'owner' | 'admin' | 'moderator';

export interface Admin {
  telegramId: number;
  role: AdminRole;
  addedBy: number | null;
  addedAt: Date;
  /** Last-seen Telegram @username (without the @) — null until they use the bot, or if they have none. */
  username: string | null;
  firstName: string | null;
}

/** Telegram profile fields remembered via `saveTelegramUser` — see `telegramUsers` in schema.ts. */
export interface TelegramUser {
  telegramId: number;
  username: string | null;
  firstName: string | null;
}

export interface ServerConfig {
  alias: string;
  rconHost: string;
  rconPort: number;
  /** Decrypted — see `secrets.ts`. Never stored in this shape. */
  rconPassword: string;
  logSourceConfig: string | null;
  boundTelegramChatId: number | null;
  /** Set via `setDefaultServer` — at most one server has it. */
  isDefault: boolean;
}

export interface UpsertServerInput {
  alias: string;
  rconHost: string;
  rconPort: number;
  rconPassword: string;
  logSourceConfig?: string | null;
}

export type AuditSource = 'telegram_button' | 'telegram_command' | 'auto';

export interface AuditLogEntry {
  id: number;
  actorTelegramId: number;
  action: string;
  target: string | null;
  serverAlias: string | null;
  reason: string | null;
  source: AuditSource;
  detailJson: unknown;
  createdAt: Date;
  /** The actor's last-seen @username/first name, if known — see `Admin.username`. */
  actorUsername: string | null;
  actorFirstName: string | null;
}

export interface RecordAuditLogInput {
  actorTelegramId: number;
  action: string;
  target?: string | null;
  serverAlias?: string | null;
  reason?: string | null;
  source: AuditSource;
  detailJson?: unknown;
}

/** "claimed" if this call created the owner row, "already-claimed" if one already existed. */
export type ClaimOwnerResult = 'claimed' | 'already-claimed';

/**
 * Thin repository over Postgres (docs/PLAN.md §3.1/§4/§7). Command handlers in `apps/gateway`
 * depend on this interface, not on Drizzle types, so they can be unit-tested with an in-memory
 * fake instead of a real database.
 */
export interface AdminStore {
  getAdmin(telegramId: number): Promise<Admin | undefined>;
  /** Race-safe per §4 — backed by a DB-level unique constraint, not check-then-insert. */
  claimOwner(telegramId: number): Promise<ClaimOwnerResult>;
  addAdmin(telegramId: number, role: AdminRole, addedBy: number): Promise<void>;
  removeAdmin(telegramId: number): Promise<void>;
  setRole(telegramId: number, role: AdminRole): Promise<void>;
  listAdmins(): Promise<Admin[]>;
  /** Upserts a user's last-seen @username/first name (shown instead of bare IDs). */
  saveTelegramUser(user: TelegramUser): Promise<void>;

  upsertServer(input: UpsertServerInput): Promise<void>;
  getServer(alias: string): Promise<ServerConfig | undefined>;
  listServers(): Promise<ServerConfig[]>;
  bindServerToChat(alias: string, chatId: number): Promise<void>;
  getServerForChat(chatId: number): Promise<ServerConfig | undefined>;
  /** Deletes the server and its per-admin scoping rows. `false` if no such server existed. */
  removeServer(alias: string): Promise<boolean>;
  /** Makes this server the only default one. `false` (nothing changed) if no such server exists. */
  setDefaultServer(alias: string): Promise<boolean>;
  getDefaultServer(): Promise<ServerConfig | undefined>;

  /** A setting changed from Telegram, or `undefined` if it was never set (or was reset). */
  getSetting(key: string): Promise<unknown>;
  setSetting(key: string, value: unknown): Promise<void>;
  deleteSetting(key: string): Promise<void>;

  recordAuditLog(entry: RecordAuditLogInput): Promise<void>;
  listAuditLog(limit: number): Promise<AuditLogEntry[]>;
  /**
   * Prior kicks/bans/etc. against a given player name (docs/PLAN.md §5 step 3's report
   * enrichment), newest first. Case-insensitive exact match on `target` — command handlers
   * record the player's name there verbatim (e.g. `apps/gateway/src/lib/commands/ban.ts`), not a
   * structured GUID/IP, so that's the only identity this can match on regardless of the report's
   * own GUID/IP correlation rule (§2.4).
   */
  listAuditLogForTarget(serverAlias: string, targetName: string, limit: number): Promise<AuditLogEntry[]>;

  close(): Promise<void>;
}
