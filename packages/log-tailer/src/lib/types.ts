/** Global (`say`) vs team-only (`sayteam`) chat, per the `games_mp.log` line's own channel field. */
export type ChatChannel = 'say' | 'sayteam';

/**
 * One parsed `say`/`sayteam` line from `games_mp.log`, e.g. `115:19 say;0;0;WOWOWOW;HEU!`.
 *
 * The line's own fields are `guid;num;name;message` (docs/PLAN.md §2.4: GUID `0` is the
 * confirmed-common case on this target server, not a rare one). `name` can be empty — observed
 * empirically right after a player connects, before their name has propagated into the log
 * stream (`test/fixtures/chat-lines.log`) — so callers must not assume it is populated.
 */
export interface ChatEvent {
  channel: ChatChannel;
  guid: string;
  num: number;
  name: string;
  message: string;
  timestamp: { minutes: number; seconds: number };
  raw: string;
}

/** A `!report <target> [reason...]` chat trigger extracted from a `ChatEvent` (docs/PLAN.md §5 step 1). */
export interface ReportTrigger {
  chat: ChatEvent;
  targetName: string;
  reason?: string;
}

/** `J` (connect) vs `Q` (quit/disconnect), per `games_mp.log`'s own event code. */
export type SessionEventKind = 'connect' | 'disconnect';

/**
 * One parsed `J`/`Q` line from `games_mp.log`, e.g. `121:19 J;0;0;WOWOWOW` — same
 * `guid;num;name` shape as a `ChatEvent`, just without a trailing message field.
 */
export interface SessionEvent {
  kind: SessionEventKind;
  guid: string;
  num: number;
  name: string;
  timestamp: { minutes: number; seconds: number };
  raw: string;
}

/**
 * In-memory state for one connected (or recently-disconnected) client slot, built up by
 * `SessionTracker` from `SessionEvent`/`ChatEvent`s (docs/PLAN.md §5 step 3). Keyed by `num`
 * (the client slot), not `guid` — GUID is frequently `0` for multiple concurrent players
 * (§2.4), so it can't identify a specific connection on its own.
 *
 * A session is not deleted on disconnect — `disconnectedAt` is set instead and the record is
 * kept (until that slot's next `connect` overwrites it) so report-pipeline's "target already
 * disconnected" fallback (§5 step 2) has somewhere to read last-known info from.
 */
export interface PlayerSession {
  num: number;
  guid: string;
  name: string;
  /** Wall-clock `Date.now()` ms when this slot's `connect` line was seen — NOT the in-game
   *  `mm:ss` timestamp, which resets to 0 on every map change and so can't measure a session
   *  that spans a map rotation. */
  connectedAt: number;
  disconnectedAt?: number;
  chatHistory: ChatEvent[];
}
