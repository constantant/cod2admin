import type { SessionEvent } from './types.js';

/**
 * Matches a connect/quit line from `games_mp.log`:
 * `<minutes>:<seconds> (J|Q);<guid>;<num>;<name>` — e.g. `121:19 J;0;0;WOWOWOW` (captured
 * verbatim, `test/fixtures/chat-lines.log`). Same `guid;num;name` shape as a chat line, just
 * without a trailing message field, so `<name>` is the rest of the line rather than `[^;]*`.
 *
 * Leading `\s*`: see the identical note on `CHAT_LINE` in chat-parser.ts — a live deployment
 * writes every line with a leading space that this fixture doesn't have.
 */
const SESSION_EVENT_LINE = /^\s*(\d+):(\d{2}) (J|Q);(-?\d+);(-?\d+);(.*)$/;

/** Parses one `games_mp.log` line as a connect/quit event, or returns null for anything else. */
export function parseSessionEventLine(line: string): SessionEvent | null {
  const match = SESSION_EVENT_LINE.exec(line);
  if (!match) {
    return null;
  }
  const [, minutes, seconds, kindCode, guid, num, name] = match;
  return {
    kind: kindCode === 'J' ? 'connect' : 'disconnect',
    guid,
    num: Number.parseInt(num, 10),
    name,
    timestamp: { minutes: Number.parseInt(minutes, 10), seconds: Number.parseInt(seconds, 10) },
    raw: line,
  };
}
