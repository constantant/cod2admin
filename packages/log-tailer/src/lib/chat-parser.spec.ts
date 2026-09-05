import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectReportTrigger, parseChatLine } from './chat-parser.js';

const FIXTURE_PATH = fileURLToPath(new URL('../../test/fixtures/chat-lines.log', import.meta.url));
// Normalize CRLF: this repo's core.autocrlf can check this fixture out with \r\n on Windows.
const FIXTURE_LINES = readFileSync(FIXTURE_PATH, 'utf-8').replace(/\r\n/g, '\n').split('\n');

/**
 * The first 11 lines of the fixture are captured verbatim from a real dedicated server
 * (docs/PLAN.md §2.4/§11.2) — including the empty-name quirk on a player's first chat lines
 * right after connecting, before their name propagates into the log stream. Everything after
 * that is hand-constructed to cover `sayteam`, `!report` (including case-insensitivity and the
 * no-reason form), and the "bare `report`, no `!`" false-positive case, none of which occurred
 * in that live session.
 */
describe('parseChatLine', () => {
  it('parses a real say line where the name has not propagated yet (empty name, GUID 0)', () => {
    expect(parseChatLine(FIXTURE_LINES[3])).toEqual({
      channel: 'say',
      guid: '0',
      num: 0,
      name: '',
      message: 'WHAT/???',
      timestamp: { minutes: 112, seconds: 55 },
      raw: FIXTURE_LINES[3],
    });
  });

  it('parses a real say line with a populated name', () => {
    expect(parseChatLine(FIXTURE_LINES[8])).toEqual({
      channel: 'say',
      guid: '0',
      num: 0,
      name: 'WOWOWOW',
      message: 'HEU!',
      timestamp: { minutes: 115, seconds: 19 },
      raw: FIXTURE_LINES[8],
    });
  });

  it('parses a sayteam line the same way as say, just with its own channel', () => {
    const line = '120:03 sayteam;0;1;WOWOWOW;cover the flag';
    expect(parseChatLine(line)).toEqual({
      channel: 'sayteam',
      guid: '0',
      num: 1,
      name: 'WOWOWOW',
      message: 'cover the flag',
      timestamp: { minutes: 120, seconds: 3 },
      raw: line,
    });
  });

  it('returns null for non-chat lines (kill/death events, server noise)', () => {
    expect(parseChatLine(FIXTURE_LINES[10])).toBeNull(); // a `D;...` death-event line
    expect(parseChatLine('Sending heartbeat to cod2master.fucker    .com')).toBeNull();
    expect(parseChatLine('Rcon from 172.18.0.1:-21456:')).toBeNull();
  });
});

describe('detectReportTrigger', () => {
  it('extracts target and reason from a real-format !report line', () => {
    const chat = parseChatLine('123:05 say;0;0;WOWOWOW;!report Cheatr123 aimbot + wallhack')!;
    expect(detectReportTrigger(chat)).toEqual({
      chat,
      targetName: 'Cheatr123',
      reason: 'aimbot + wallhack',
    });
  });

  it('works over sayteam too', () => {
    const chat = parseChatLine('124:11 sayteam;0;1;WOWOWOW;!report Cheatr123 also teamkilling')!;
    expect(detectReportTrigger(chat)?.targetName).toBe('Cheatr123');
  });

  it('leaves reason undefined when none is given', () => {
    const chat = parseChatLine('125:00 say;0;0;WOWOWOW;!report NoReasonGuy')!;
    expect(detectReportTrigger(chat)).toEqual({ chat, targetName: 'NoReasonGuy', reason: undefined });
  });

  it('is case-insensitive on the !report prefix', () => {
    const chat = parseChatLine('126:47 say;0;0;WOWOWOW;!REPORT UpperCaseGuy still works')!;
    expect(detectReportTrigger(chat)).toEqual({
      chat,
      targetName: 'UpperCaseGuy',
      reason: 'still works',
    });
  });

  it('does not trigger on a bare "report" without the ! prefix (§5 step 1 false-positive case)', () => {
    const chat = parseChatLine(
      '122:40 say;0;0;WOWOWOW;this guy is hacking, report card table flip',
    )!;
    expect(detectReportTrigger(chat)).toBeNull();
  });

  it('does not trigger on a bare "!report" with no target name', () => {
    const chat = parseChatLine('999:00 say;0;0;WOWOWOW;!report')!;
    expect(detectReportTrigger(chat)).toBeNull();
  });
});
