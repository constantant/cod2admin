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
