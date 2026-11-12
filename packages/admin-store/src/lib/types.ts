import type { Permission } from './permissions.js';

export type { Permission } from './permissions.js';

export interface Admin {
  telegramId: number;
  /** The one account `/claim` or `OWNER_TELEGRAM_ID` created. Has every permission. */
  isOwner: boolean;
  /**
   * Ids this person was granted. Empty for the owner — `isOwner` is what grants them,
   * so a new permission does not need a row.
   */
  permissions: Permission[];
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

export type WatchMode = 'off' | 'flag' | 'report' | 'kick';
export type WatchJoin = 'spectator' | 'private';

/**
 * Per-server watcher settings (`servers.watch`). Null on the row means off.
 * The private password is not a field here.
 */
export interface ServerWatchSettings {
  /** False stays disconnected. True with `mode: 'off'` is a valid stored state. */
  enabled: boolean;
  mode: WatchMode;
  flagZ: number;
  kickZ: number;
  minFeatureN: number;
  minSelfLives: number;
  kickExtremeLives: number;
  kickMinSessionLives: number;
  cooldownMs: number;
  maxKicksPerHour: number;
  maxCardsPerHour: number;
  spectatorName: string;
  join: WatchJoin;
  /** `sv_privateclients` before a private slot was reserved. Not a secret. */
  privateClientsPrevious: number | null;
  negotiatedProtocol: number | null;
  confirmedAimFeatures: 0 | 1 | 2;
}

export interface ServerConfig {
  alias: string;
  rconHost: string;
  rconPort: number;
  /** Decrypted — see `secrets.ts`. Never stored in this shape. */
  rconPassword: string;
  logSourceConfig: string | null;
  /** Admin chat (reports). */
  boundTelegramChatId: number | null;
  /** Public group (match results); null falls back to the admin chat. */
  publicTelegramChatId: number | null;
  /** Set via `setDefaultServer` — at most one server has it. */
  isDefault: boolean;
  /** Null: the watcher is off. Never includes the private password. */
  watch: ServerWatchSettings | null;
  /** Decrypted. Null when no private password is stored. */
  watchPrivatePassword: string | null;
  /** True only when this bot generated `watchPrivatePassword`. */
  watchPrivatePasswordOwned: boolean;
}

export interface UpsertServerInput {
  alias: string;
  rconHost: string;
  rconPort: number;
  rconPassword: string;
  /** Left out: an existing server keeps its path, which `setServerLogPath` may have set. */
  logSourceConfig?: string | null;
}

/** `miniapp`: an action taken from the Telegram Mini App (docs/PLAN-miniapp.md §7). */
/** `mcp`: an action taken by an AI the staff member connected (docs/PLAN.md §4). */
export type AuditSource =
  'telegram_button' | 'telegram_command' | 'auto' | 'miniapp' | 'mcp';

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

export interface AuditLogFilter {
  /** Case-insensitive substring of the target or the reason. */
  query?: string;
  action?: string;
  actorTelegramId?: number;
  serverAlias?: string;
  source?: AuditSource;
  since?: Date;
  until?: Date;
  limit: number;
  offset?: number;
}

export type ReportStatus = 'open' | 'handled' | 'ignored';

/** `player` is an in-game `!report`. `watch` must not collapse into that row. */
export type ReportOrigin = 'player' | 'watch';

export interface Report {
  id: number;
  serverAlias: string;
  reporterName: string;
  reporterGuid: string | null;
  targetName: string;
  reason: string | null;
  /** Omitted on write means `player`. */
  origin: ReportOrigin;
  status: ReportStatus;
  /** How many times this report was filed while open. */
  count: number;
  createdAt: Date;
  lastReportedAt: Date;
  resolvedBy: number | null;
  resolvedAt: Date | null;
  outcome: string | null;
}

export interface RecordReportInput {
  serverAlias: string;
  reporterName: string;
  reporterGuid?: string | null;
  targetName: string;
  reason?: string | null;
  /** Omitted reports are `player`. */
  origin?: ReportOrigin;
}

export interface ReportFilter {
  /** Open reports only, or resolved ones only. */
  resolved: boolean;
  serverAlias?: string;
  limit: number;
  offset?: number;
}

export type PlayerNoteKind = 'guid' | 'ip' | 'name';

export interface PlayerNote {
  id: number;
  kind: PlayerNoteKind;
  value: string;
  note: string;
  watch: boolean;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AddPlayerNoteInput {
  kind: PlayerNoteKind;
  value: string;
  note: string;
  watch: boolean;
  createdBy: number;
}

export interface PlayerNoteFilter {
  /** Case-insensitive substring of the value or the note. */
  query?: string;
  watchOnly?: boolean;
  limit: number;
  offset?: number;
}

export interface KnownPlayer {
  /** Lower case, colour codes stripped — the key. */
  name: string;
  /** As the admin typed it. */
  display: string;
  /** Provider networks (ASNs) the player connects from. */
  asns: number[];
  /** Real GUIDs of this player; may be empty (most players have GUID 0). */
  guids: string[];
  note: string | null;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveKnownPlayerInput {
  name: string;
  display: string;
  asns: number[];
  guids: string[];
  note?: string | null;
  createdBy: number;
}

export interface ServerSnapshot {
  serverAlias: string;
  at: Date;
  online: boolean;
  playerCount: number;
  maxClients: number | null;
  map: string | null;
  gametype: string | null;
}

export type RecordSnapshotInput = Omit<ServerSnapshot, 'at'>;

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
  /** Adds a non-owner. Pass an empty list when they should only be able to read. */
  addAdmin(
    telegramId: number,
    permissions: readonly Permission[],
    addedBy: number,
  ): Promise<void>;
  removeAdmin(telegramId: number): Promise<void>;
  /** Replaces the stored grants. Does not accept the owner; callers refuse that first. */
  setPermissions(
    telegramId: number,
    permissions: readonly Permission[],
  ): Promise<void>;
  listAdmins(): Promise<Admin[]>;
  /** Upserts a user's last-seen @username/first name (shown instead of bare IDs). */
  saveTelegramUser(user: TelegramUser): Promise<void>;

  upsertServer(input: UpsertServerInput): Promise<void>;
  setServerLogPath(alias: string, path: string | null): Promise<void>;
  getServer(alias: string): Promise<ServerConfig | undefined>;
  listServers(): Promise<ServerConfig[]>;
  /** `kind` picks the slot: the admin chat (reports) or the public group (match results). */
  bindServerToChat(
    alias: string,
    chatId: number,
    kind?: 'admin' | 'public',
  ): Promise<void>;
  /** Clears whichever slot(s) of `alias` point at `chatId`; returns what was cleared (empty: it wasn't bound here). */
  unbindServerFromChat(
    alias: string,
    chatId: number,
  ): Promise<Array<'admin' | 'public'>>;
  getServerForChat(chatId: number): Promise<ServerConfig | undefined>;
  /** Deletes the server and its per-admin scoping rows. `false` if no such server existed. */
  removeServer(alias: string): Promise<boolean>;
  /** Makes this server the only default one. `false` (nothing changed) if no such server exists. */
  setDefaultServer(alias: string): Promise<boolean>;
  getDefaultServer(): Promise<ServerConfig | undefined>;
  /**
   * Replaces `servers.watch`. `false` if no such server exists.
   * Refuses `mode: 'kick'` unless `confirmedAimFeatures` is 2.
   * The private password is not accepted here.
   */
  setServerWatch(
    alias: string,
    settings: ServerWatchSettings,
  ): Promise<boolean>;
  /**
   * Writes the private-password column. `null` clears it and clears `owned`.
   * `false` if no such server exists. The plaintext is never put in `servers.watch`.
   */
  setWatchPrivatePassword(
    alias: string,
    password: string | null,
    owned: boolean,
  ): Promise<boolean>;

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
  listAuditLogForTarget(
    serverAlias: string,
    targetName: string,
    limit: number,
  ): Promise<AuditLogEntry[]>;
  /** The Mini App's audit viewer, newest first. */
  searchAuditLog(filter: AuditLogFilter): Promise<AuditLogEntry[]>;
  /** Every distinct action in the log, sorted — the viewer's filter choices. */
  listAuditActions(): Promise<string[]>;

  /** Saves a report, or counts it on the open row with the same server, reporter, target, and origin. */
  recordReport(input: RecordReportInput): Promise<Report>;
  getReport(id: number): Promise<Report | undefined>;
  /** Newest first. */
  searchReports(filter: ReportFilter): Promise<Report[]>;
  countOpenReports(): Promise<number>;
  /** Closes an open report. `undefined` if there's none with that ID, or it's closed already. */
  resolveReport(
    id: number,
    resolution: {
      status: Exclude<ReportStatus, 'open'>;
      resolvedBy: number;
      outcome?: string | null;
    },
  ): Promise<Report | undefined>;

  addPlayerNote(input: AddPlayerNoteInput): Promise<PlayerNote>;
  getPlayerNote(id: number): Promise<PlayerNote | undefined>;
  /** Newest change first. */
  searchPlayerNotes(filter: PlayerNoteFilter): Promise<PlayerNote[]>;
  /** Notes on any of these exact identities, newest change first. */
  findPlayerNotes(
    identities: { kind: PlayerNoteKind; value: string }[],
  ): Promise<PlayerNote[]>;
  updatePlayerNote(
    id: number,
    changes: { note?: string; watch?: boolean },
  ): Promise<PlayerNote | undefined>;
  /** `false` if no such note existed. */
  deletePlayerNote(id: number): Promise<boolean>;

  /** Sorted by name. */
  listKnownPlayers(): Promise<KnownPlayer[]>;
  /** Creates the entry, or replaces the ASNs/display/note of the one with this name. */
  saveKnownPlayer(input: SaveKnownPlayerInput): Promise<KnownPlayer>;
  /** `false` if no entry had this name. */
  deleteKnownPlayer(name: string): Promise<boolean>;

  recordServerSnapshot(input: RecordSnapshotInput): Promise<void>;
  /** Oldest first. */
  listServerSnapshots(
    serverAlias: string,
    since: Date,
  ): Promise<ServerSnapshot[]>;
  /** Deletes every snapshot older than `before`, on all servers. */
  pruneServerSnapshots(before: Date): Promise<void>;

  close(): Promise<void>;
}
