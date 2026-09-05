import type { ChatEvent, ReportTrigger } from './types.js';

/**
 * Matches a `say`/`sayteam` line from `games_mp.log`:
 * `<minutes>:<seconds> (say|sayteam);<guid>;<num>;<name>;<message>` — e.g.
 * `115:19 say;0;0;WOWOWOW;HEU!` (captured verbatim from a real dedicated server,
 * test/fixtures/chat-lines.log). `<name>` is deliberately `[^;]*` (not `+`): it can be empty.
 */
const CHAT_LINE = /^(\d+):(\d{2}) (say|sayteam);(-?\d+);(-?\d+);([^;]*);(.*)$/;

/** `!report` must be its own word — `!reportcard` or `!reporting` must not match. */
const REPORT_TRIGGER = /^!report(?:\s+(\S+)(?:\s+(.*))?)?$/i;

/** Parses one `games_mp.log` line as a `say`/`sayteam` event, or returns null for anything else. */
export function parseChatLine(line: string): ChatEvent | null {
  const match = CHAT_LINE.exec(line);
  if (!match) {
    return null;
  }
  const [, minutes, seconds, channel, guid, num, name, message] = match;
  return {
    channel: channel as ChatEvent['channel'],
    guid,
    num: Number.parseInt(num, 10),
    name,
    message,
    timestamp: { minutes: Number.parseInt(minutes, 10), seconds: Number.parseInt(seconds, 10) },
    raw: line,
  };
}

/**
 * Detects the `!report <target> [reason...]` trigger (docs/PLAN.md §5 step 1) in a chat event.
 * Requires the literal `!report` prefix — a bare `report` (e.g. "reporting in") does not match,
 * avoiding false positives from ordinary chat. A `!report` with no target name is not a usable
 * trigger (nothing to resolve against `status`) and also returns null.
 */
export function detectReportTrigger(chat: ChatEvent): ReportTrigger | null {
  const match = REPORT_TRIGGER.exec(chat.message.trim());
  const targetName = match?.[1];
  if (!targetName) {
    return null;
  }
  return { chat, targetName, reason: match[2] || undefined };
}
