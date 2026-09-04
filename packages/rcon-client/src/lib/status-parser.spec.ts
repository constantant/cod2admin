import { describe, expect, it } from 'vitest';
import {
  parseCvarBlock,
  parseOobPlayerLine,
  parseRconStatusTable,
  stripColorCodes,
} from './status-parser.js';

describe('stripColorCodes', () => {
  it('removes ^-digit color codes', () => {
    expect(stripColorCodes('^1Player^7One')).toBe('PlayerOne');
  });

  it('leaves plain names untouched', () => {
    expect(stripColorCodes('PlayerTwo')).toBe('PlayerTwo');
  });
});

describe('parseCvarBlock', () => {
  it('parses a leading-backslash key/value block', () => {
    expect(parseCvarBlock('\\sv_hostname\\Test Server\\gametype\\dm')).toEqual({
      sv_hostname: 'Test Server',
      gametype: 'dm',
    });
  });

  it('returns an empty object for an empty block', () => {
    expect(parseCvarBlock('')).toEqual({});
  });
});

describe('parseOobPlayerLine', () => {
  it('parses a quoted-name getstatus player line', () => {
    expect(parseOobPlayerLine('5 42 "PlayerOne"')).toEqual({ score: 5, ping: 42, name: 'PlayerOne' });
  });

  it('returns null for lines that do not match the expected shape', () => {
    expect(parseOobPlayerLine('not a player line')).toBeNull();
    expect(parseOobPlayerLine('')).toBeNull();
  });
});

/** Builds a status table whose column widths exactly match the separator dashes. */
function buildStatusTable(mapName: string, rows: string[][]): string {
  const header = ['num', 'score', 'ping', 'name', 'lastmsg', 'address', 'qport', 'rate'];
  const widths = [3, 5, 4, 15, 7, 21, 5, 5];
  const pad = (value: string, width: number) => (value.length >= width ? value : value.padEnd(width));
  const headerLine = header.map((name, i) => pad(name, widths[i])).join(' ');
  const separatorLine = widths.map((width) => '-'.repeat(width)).join(' ');
  const dataLines = rows.map((cols) => cols.map((value, i) => pad(value, widths[i])).join(' '));
  return [`map: ${mapName}`, headerLine, separatorLine, ...dataLines].join('\n');
}

describe('parseRconStatusTable', () => {
  it('parses map name and the player table, including split IP/port and color-stripped names', () => {
    const table = buildStatusTable('mp_toujane', [
      ['0', '5', '42', '^1Player^7One', '0', '123.45.67.89:12345', '54321', '25000'],
      ['1', '0', '12', 'PlayerTwo', '3', '98.76.54.32:5555', '11111', '20000'],
    ]);

    const status = parseRconStatusTable(table);

    expect(status.mapName).toBe('mp_toujane');
    expect(status.players).toEqual([
      { num: 0, score: 5, ping: 42, name: 'PlayerOne', lastmsg: 0, ip: '123.45.67.89', port: 12345, qport: 54321, rate: 25000 },
      { num: 1, score: 0, ping: 12, name: 'PlayerTwo', lastmsg: 3, ip: '98.76.54.32', port: 5555, qport: 11111, rate: 20000 },
    ]);
  });

  it('returns an empty player list when there is no table (e.g. unexpected output)', () => {
    const status = parseRconStatusTable('some unrelated print output');
    expect(status.players).toEqual([]);
  });

  it('skips blank lines after the table', () => {
    const table = buildStatusTable('mp_toujane', [['0', '5', '42', 'Solo', '0', '1.2.3.4:1000', '1', '20000']]);
    const status = parseRconStatusTable(`${table}\n\n`);
    expect(status.players).toHaveLength(1);
  });
});
