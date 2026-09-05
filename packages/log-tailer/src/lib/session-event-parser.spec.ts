import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSessionEventLine } from './session-event-parser.js';

const FIXTURE_PATH = fileURLToPath(new URL('../../test/fixtures/chat-lines.log', import.meta.url));
const FIXTURE_LINES = readFileSync(FIXTURE_PATH, 'utf-8').replace(/\r\n/g, '\n').split('\n');

describe('parseSessionEventLine', () => {
  it('parses a real connect (J) line', () => {
    expect(parseSessionEventLine(FIXTURE_LINES[12])).toEqual({
      kind: 'connect',
      guid: '0',
      num: 0,
      name: 'WOWOWOW',
      timestamp: { minutes: 121, seconds: 19 },
      raw: FIXTURE_LINES[12],
    });
  });

  it('parses a real quit (Q) line', () => {
    expect(parseSessionEventLine(FIXTURE_LINES[18])).toEqual({
      kind: 'disconnect',
      guid: '0',
      num: 0,
      name: 'WOWOWOW',
      timestamp: { minutes: 127, seconds: 16 },
      raw: FIXTURE_LINES[18],
    });
  });

  it('returns null for non-connect/quit lines (chat, kill/death events, server noise)', () => {
    expect(parseSessionEventLine(FIXTURE_LINES[8])).toBeNull(); // a `say;...` line
    expect(parseSessionEventLine(FIXTURE_LINES[10])).toBeNull(); // a `D;...` death-event line
    expect(parseSessionEventLine('Sending heartbeat to cod2master.fucker    .com')).toBeNull();
  });
});
