/**
 * The Mini App's HTTP/WebSocket contract (docs/PLAN-miniapp.md §5) — plain types, no imports, so
 * `apps/miniapp-web` can use this same file (through a tsconfig path) and both sides stay in step.
 * Dates travel as ISO strings.
 */

export type MiniAppRole = 'owner' | 'admin' | 'moderator';

export interface MeResponse {
  user: { id: number; username: string | null; firstName: string | null };
  role: MiniAppRole;
  version: string;
  servers: ServerSummary[];
  /** The server to open first: `/setdefault`'s, else the one from `.env`. */
  defaultServer: string;
  /** `!report`s nobody has dealt with yet, on all servers. */
  openReports: number;
}

export interface ServerSummary {
  alias: string;
  /** Whether a live chat feed exists — only when the bot can read this server's `games_mp.log`. */
  chat: boolean;
}

export interface PlayerDto {
  num: number;
  /** As `status` reports it, `^N` colour codes included — the UI renders them. */
  name: string;
  score: number;
  ping: number;
  /** `null` when the server reports none or GUID 0 (most players — docs/PLAN.md §2.4). */
  guid: string | null;
  ip: string | null;
  /** ISO code or `LAN` — absent when the IP database is off or doesn't know the IP. */
  countryCode?: string;
  /** e.g. `Russia, Yekaterinburg (Sverdlovsk Oblast)`. */
  location?: string;
  provider?: string;
  /** e.g. `🛡 VPN` — set only when the IP is flagged. */
  vpn?: string;
  /** Someone wrote a note on this GUID, IP or name. */
  noted?: boolean;
  /** On the watchlist. */
  watched?: boolean;
}

export interface StatusResponse {
  server: string;
  hostname: string | null;
  mapName: string | null;
  players: PlayerDto[];
  fetchedAt: string;
}

export type ModerationKind = 'kick' | 'tempban' | 'ban';

export interface ModerationRequest {
  /** The name the admin saw in the slot — the action is refused if the slot now holds someone else. */
  name: string;
  reason?: string;
  /** `tempban`: default 30 minutes, like the report card's button. Mute: none means until lifted. */
  durationMinutes?: number;
}

export interface ActionResponse {
  message: string;
}

export interface MapsResponse {
  current: string | null;
  /** The game mode now, e.g. `ctf`. */
  currentGametype: string | null;
  /** Every mode the server has (stock: ctf, dm, hq, sd, tdm, plus a mod's own). Empty if it can't list them. */
  gametypes: string[];
  /** The mode the app suggests first: `ctf` when the server has it, else the current one. */
  defaultGametype: string | null;
  /** `sv_mapRotation` as map + mode pairs; a map can be there under more than one mode. */
  rotation: { map: string; gametype: string | null }[];
  /** Every installed map (the rotation's maps if the server can't list them). */
  maps: { name: string; stock: boolean; inRotation: boolean }[];
}

export interface ChangeMapRequest {
  map: string;
  /** Switch the game mode too. Omitted: the map loads in the current mode. */
  gametype?: string;
}

export interface ConsoleResponse {
  output: string;
}

export type ChatChannel = 'say' | 'sayteam' | 'tell';

export interface ChatLineDto {
  /** Increasing per server since the bot started; backfilled lines come first. */
  id: number;
  /** When the bot saw the line — `null` for lines read from the log's history. */
  at: string | null;
  channel: ChatChannel;
  /** `game`: a player wrote it; `admin`: sent from the Mini App. */
  source: 'game' | 'admin';
  num: number | null;
  name: string;
  message: string;
  /** `tell` only: the player it went to. */
  to?: string;
}

export interface ChatResponse {
  /** `false` when the bot can't read the server's log (RCON-only install) — no feed to show. */
  available: boolean;
  lines: ChatLineDto[];
}

export interface SayRequest {
  message: string;
}

export interface TellRequest {
  num: number;
  name: string;
  message: string;
}

export type BanKind = 'guid' | 'ip';

export interface BanDto {
  kind: BanKind;
  id: number;
  /** The server it was issued on — bans apply on every server. */
  server: string;
  /** GUID bans only. */
  guid: string | null;
  /** The player's name then. IP bans may have none: manual ones, and those older than the column. */
  name: string | null;
  /** IP bans only. */
  ip: string | null;
  countryCode?: string;
  location?: string;
  reason: string | null;
  bannedBy: string;
  bannedAt: string;
  expiresAt: string | null;
  liftedAt: string | null;
}

export interface BansResponse {
  items: BanDto[];
  /** Whether asking for the next page could return more. */
  more: boolean;
}

export interface UpdateBanRequest {
  reason?: string | null;
  /** ISO time in the future, or `null` to make the ban permanent. */
  expiresAt?: string | null;
}

export interface UpdateBanResponse {
  ban: BanDto;
  /** Something the admin should know, e.g. a server whose `ban.txt` couldn't be updated. */
  warning?: string;
}

export interface UnbanRequest {
  /** GUIDs and/or IPs. */
  targets: string[];
}

export interface UnbanResult {
  target: string;
  lifted: number;
  /** Servers whose `ban.txt` may still block the player. */
  unanswered: string[];
}

export interface UnbanResponse {
  results: UnbanResult[];
}

/**
 * A ban for someone who isn't (necessarily) online. `server` is where it's recorded as issued; it
 * applies everywhere. No `durationMinutes` means permanent.
 */
export type AddBanRequest = {
  server: string;
  reason?: string;
  durationMinutes?: number | null;
} & ({ kind: 'ip'; ip: string } | { kind: 'guid'; guid: string; name: string });

/** A chat mute. It applies on every server; `server` is where it was issued. */
export interface MuteDto {
  id: number;
  server: string;
  name: string;
  guid: string | null;
  ip: string | null;
  reason: string | null;
  mutedBy: string;
  mutedAt: string;
  /** `null`: until someone lifts it. */
  expiresAt: string | null;
}

export interface MutesResponse {
  items: MuteDto[];
}

export interface ApiError {
  error: string;
  message: string;
}

/** Client → server over `/api/ws`. The first message must be `auth`. */
export type LiveClientMessage =
  { type: 'auth'; initData: string } | { type: 'subscribe'; server: string };

/** Server → client over `/api/ws`. */
export type LiveServerMessage =
  | { type: 'ready'; role: MiniAppRole }
  | { type: 'status'; status: StatusResponse }
  | { type: 'statusError'; server: string; message: string }
  | { type: 'chat'; server: string; line: ChatLineDto }
  | {
      type: 'reports';
      openReports: number;
      /** Set when this update is a new report, not one being closed. */
      added?: { server: string; target: string; reporter: string };
    }
  | { type: 'error'; error: string; message: string };

// ── Dashboard ───────────────────────────────────────────────────────────────────────────────

export interface DashboardHistory {
  /** How many checks the period has — one a minute, kept for 30 days. */
  samples: number;
  /** Oldest first. `players` is `null` when the server didn't answer in that slice of time. */
  points: { at: string; players: number | null }[];
  peak: { players: number; at: string } | null;
  average: number | null;
  uptimePercent: number | null;
  /** The maps played most, by time with at least one player on. */
  topMaps: { map: string; percent: number }[];
}

export interface DashboardResponse {
  server: string;
  online: boolean;
  hostname: string | null;
  map: string | null;
  gametype: string | null;
  players: number;
  maxClients: number | null;
  hours: number;
  history: DashboardHistory;
}

// ── Servers ─────────────────────────────────────────────────────────────────────────────────

export interface ServerDto {
  alias: string;
  isDefault: boolean;
  chat: boolean;
  online: boolean;
  hostname: string | null;
  map: string | null;
  gametype: string | null;
  players: number;
  maxClients: number | null;
  /** Admin and owner only — a moderator sees what's on, not how the bot reaches it. */
  connection?: {
    host: string;
    port: number;
    logPath: string | null;
    /** `!report` cards have a chat to go to (`/bindserver`, sent in that chat). */
    boundChat: boolean;
    /** Set in the bot's `.env`, so it can't be changed or removed from here. */
    fromConfig: boolean;
    /** `COD2_LOG_PATH` is set, so the log path can't be changed from here. */
    logFromConfig: boolean;
  };
}

export interface ServersResponse {
  servers: ServerDto[];
}

export interface AddServerRequest {
  alias: string;
  host: string;
  port: number;
  password: string;
}

export type LogRequest =
  { action: 'search' } | { action: 'off' } | { action: 'set'; path: string };

export interface LogResponse {
  logPath: string | null;
  /** `true`: the log is now in use, or was turned off. `false`: nothing changed, see `message`. */
  changed: boolean;
  message: string;
  /** Files that could be the log — pick one with `action: 'set'`. */
  possible: string[];
}

export type LevelCommand = 'restart' | 'fastrestart' | 'rotate';

export interface RotationRequest {
  entries: { map: string; gametype: string | null }[];
}

export interface CvarsResponse {
  cvars: { name: string; value: string }[];
}

export interface SetCvarRequest {
  name: string;
  value: string;
}

// ── Admins ──────────────────────────────────────────────────────────────────────────────────

export interface AdminDto {
  telegramId: number;
  role: MiniAppRole;
  username: string | null;
  firstName: string | null;
  addedBy: string | null;
  addedAt: string;
  /** Whether the person asking may change or remove this one. */
  manageable: boolean;
}

export interface AdminsResponse {
  admins: AdminDto[];
  /** The roles the person asking may hand out. */
  assignable: MiniAppRole[];
}

export interface AddAdminRequest {
  telegramId: number;
  role: MiniAppRole;
}

// ── Audit log ───────────────────────────────────────────────────────────────────────────────

export type AuditSourceDto =
  'telegram_button' | 'telegram_command' | 'auto' | 'miniapp';

export interface AuditEntryDto {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  server: string | null;
  reason: string | null;
  source: AuditSourceDto;
  /** Pretty-printed, when the entry has more to say. */
  detail: string | null;
}

export interface AuditResponse {
  items: AuditEntryDto[];
  more: boolean;
  /** Every action in the log, for the filter. */
  actions: string[];
}

// ── Reports ─────────────────────────────────────────────────────────────────────────────────

export type ReportStatusDto = 'open' | 'handled' | 'ignored';

export interface ReportDto {
  id: number;
  server: string;
  reporter: string;
  target: string;
  reason: string | null;
  status: ReportStatusDto;
  count: number;
  createdAt: string;
  lastReportedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  outcome: string | null;
  /** Open reports: connected players whose name matches the target. */
  candidates: PlayerDto[];
}

export interface ReportsResponse {
  items: ReportDto[];
  more: boolean;
}

export interface ResolveReportRequest {
  status: 'handled' | 'ignored';
  outcome?: string;
}

// ── Player notes & history ──────────────────────────────────────────────────────────────────

export type NoteKind = 'guid' | 'ip' | 'name';

export interface NoteDto {
  id: number;
  kind: NoteKind;
  value: string;
  note: string;
  watch: boolean;
  author: string;
  /** Whether the person asking may edit or delete it: its author, or an admin. */
  editable: boolean;
  updatedAt: string;
}

export interface NotesResponse {
  items: NoteDto[];
  more: boolean;
}

export interface AddNoteRequest {
  kind: NoteKind;
  value: string;
  note: string;
  watch: boolean;
}

export interface UpdateNoteRequest {
  note?: string;
  watch?: boolean;
}

export interface PlayerHistoryResponse {
  notes: NoteDto[];
  bans: BanDto[];
  actions: AuditEntryDto[];
}

// ── Presets ─────────────────────────────────────────────────────────────────────────────────

export interface Presets {
  /** Offered when kicking or banning. */
  reasons: string[];
  /** Temp-ban lengths, in minutes. */
  durations: number[];
  /** Ready-made lines for the chat. */
  messages: string[];
}

// ── VPN ─────────────────────────────────────────────────────────────────────────────────────

export interface VpnResponse {
  /** `false` when `VPN_FLAG_ENABLED=false`: nobody gets flagged, so kicks do nothing. */
  flagsEnabled: boolean;
  kickEnabled: boolean;
  exempt: string[];
  networks: { asn: number; name: string | null }[];
}

// ── Telegram routes ─────────────────────────────────────────────────────────────────────────

export interface RelaysResponse {
  /** The route in use now. */
  current: string;
  direct: boolean;
  relays: string[];
  /** Every route, in the order they're tried. */
  routes: { url: string; label: string; inUse: boolean }[];
  /** Changed from the defaults. */
  changed: boolean;
}

export interface RelayTestResponse {
  results: {
    url: string;
    label: string;
    ok: boolean;
    ms?: number;
    error?: string;
  }[];
}

// ── Self-update ─────────────────────────────────────────────────────────────────────────────

export interface UpdateStatusResponse {
  /** `false`: this install can't update itself (re-run install.sh). */
  enabled: boolean;
  running: string;
  latest: string | null;
  notes: string | null;
  available: boolean;
  /** GitHub couldn't be asked. */
  checkError: string | null;
  /** The last update attempt's problem, if this process is still here to tell. */
  problem: string | null;
}

export interface ApplyUpdateRequest {
  /** The version the owner agreed to. Refused if the latest has changed since. */
  tag: string;
}
