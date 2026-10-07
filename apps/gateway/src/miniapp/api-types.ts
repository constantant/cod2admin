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
  /** `tempban` only. Default 30 minutes, like the report card's button. */
  durationMinutes?: number;
}

export interface ActionResponse {
  message: string;
}

export interface MapsResponse {
  current: string | null;
  rotation: string[];
  /** Every installed map that isn't in the rotation. Empty if the server can't list them. */
  others: { name: string; stock: boolean }[];
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
  /** GUID bans: the player's name then. IP bans have none. */
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
export type AddBanRequest = { server: string; reason?: string; durationMinutes?: number | null } & (
  | { kind: 'ip'; ip: string }
  | { kind: 'guid'; guid: string; name: string }
);

export interface ApiError {
  error: string;
  message: string;
}

/** Client → server over `/api/ws`. The first message must be `auth`. */
export type LiveClientMessage =
  | { type: 'auth'; initData: string }
  | { type: 'subscribe'; server: string };

/** Server → client over `/api/ws`. */
export type LiveServerMessage =
  | { type: 'ready'; role: MiniAppRole }
  | { type: 'status'; status: StatusResponse }
  | { type: 'statusError'; server: string; message: string }
  | { type: 'chat'; server: string; line: ChatLineDto }
  | { type: 'error'; error: string; message: string };
