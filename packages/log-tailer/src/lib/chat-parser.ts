import type { ChatEvent, ReportTrigger } from './types.js';

/**
 * Matches a `say`/`sayteam` line from `games_mp.log`:
 * `<minutes>:<seconds> (say|sayteam);<guid>;<num>;<name>;<message>` — e.g.
 * `115:19 say;0;0;WOWOWOW;HEU!` (captured verbatim from a real dedicated server,
 * test/fixtures/chat-lines.log). `<name>` is deliberately `[^;]*` (not `+`): it can be empty.
 *
 * Leading `\s*`: a live QNAP deployment (bgauduch/cod2server:7.0.0-1_3_cracked-ibuddieat,
 * confirmed 2026-09-06) writes every line with a leading space (` 115:19 say;...`) that the
 * fixture above doesn't have — without this, every single line silently failed to match and
 * `!report` never fired against a real server at all. See docs/PLAN.md §2.4/§11.1 for context on
 * this build's other real-server quirks found the same way.
 */
const CHAT_LINE = /^\s*(\d+):(\d{2}) (say|sayteam);(-?\d+);(-?\d+);([^;]*);(.*)$/;

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
 *
 * Strips leading ASCII control bytes (`\x00`-`\x1f`) before matching, not just whitespace: a live
 * QNAP deployment (confirmed 2026-09-06) logs some chat messages with a leading `` control
 * character the CoD2 client itself inserts — `.trim()` doesn't touch it, so `^!report` silently
 * never matched a single real report on that server even after the `CHAT_LINE` leading-space fix.
 */
export function detectReportTrigger(chat: ChatEvent): ReportTrigger | null {
  const message = chat.message.replace(/^[\x00-\x1f]+/, '').trim();
  const match = REPORT_TRIGGER.exec(message);
  const targetName = match?.[1];
  if (!targetName) {
    return null;
  }
  return { chat, targetName, reason: match[2] || undefined };
}
