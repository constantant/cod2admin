import { describe, expect, it } from 'vitest';
import {
  buildMatchCaption,
  parseScoreCommand,
  resolveMapPreview,
  type MatchPlayer,
} from './match-summary.js';

function player(overrides: Partial<MatchPlayer> = {}): MatchPlayer {
  return {
    name: 'Ace',
    num: 1,
    score: 16,
    minutes: 3,
    team: 1,
    bot: false,
    ...overrides,
  };
}

describe('parseScoreCommand', () => {
  it('reads Axis and Allies score commands', () => {
    expect(parseScoreCommand('d 5 12')).toEqual({ index: 5, value: 12 });
    expect(parseScoreCommand('d 6 -1')).toEqual({ index: 6, value: -1 });
    expect(parseScoreCommand('d 7 1')).toBeUndefined();
    expect(parseScoreCommand('d 5 1 extra')).toBeUndefined();
  });
});

describe('buildMatchCaption', () => {
  it('ranks score and score per minute, and shows a real team score', () => {
    const caption = buildMatchCaption({
      mapName: 'mp_toujane',
      axis: 3,
      allies: 2,
      players: [
        player({ name: '^^11Grinder', score: 16, team: 2 }),
        player({ name: '^1Ace', score: 4, team: 1 }),
        player({ name: 'Free', score: 10, team: 0 }),
        player({ name: 'AdminWatch', score: 99, team: 1, bot: true }),
        player({ name: 'Lurker', score: 40, team: 3, minutes: 10 }),
        player({ name: 'Visitor', score: 8, minutes: 0, team: 2 }),
      ],
    });
    expect(caption).toBe(
      [
        'Toujane',
        'Axis 3 — Allies 2',
        '',
        'Top scores',
        '1. Grinder — 16',
        '2. Free — 10',
        '3. Visitor — 8',
        '',
        'Most points per minute',
        '1. Grinder — 16 points in 3 min',
        '2. Free — 10 points in 3 min',
        '3. Ace — 4 points in 3 min',
      ].join('\n'),
    );
  });

  it('omits a 0–0 or a missing team score and skips an empty map', () => {
    expect(
      buildMatchCaption({
        mapName: 'mp_toujane',
        axis: 0,
        allies: 0,
        players: [player({ score: 5, minutes: 3 })],
      }),
    ).toBe(
      [
        'Toujane',
        'Top scores',
        '1. Ace — 5',
        '',
        'Most points per minute',
        '1. Ace — 5 points in 3 min',
      ].join('\n'),
    );
    expect(
      buildMatchCaption({
        mapName: 'mp_toujane',
        axis: null,
        allies: 4,
        players: [player()],
      })?.startsWith('Toujane\nTop scores'),
    ).toBe(true);
    expect(
      buildMatchCaption({
        mapName: 'mp_toujane',
        axis: 0,
        allies: 0,
        players: [player({ score: 0 })],
      }),
    ).toBeNull();
    expect(
      buildMatchCaption({
        mapName: 'mp_toujane',
        axis: null,
        allies: null,
        players: [],
      }),
    ).toBeNull();
  });

  it('still posts when only the teams scored', () => {
    expect(
      buildMatchCaption({
        mapName: 'mp_carentan',
        axis: 1,
        allies: 0,
        players: [],
      }),
    ).toBe('Carentan\nAxis 1 — Allies 0');
  });

  it('leaves a one-sample player out of the efficiency list', () => {
    const caption = buildMatchCaption({
      mapName: 'mp_dawnville',
      axis: null,
      allies: null,
      players: [player({ minutes: 1.9, score: 20 })],
    });
    expect(caption).toBe('Dawnville\nTop scores\n1. Ace — 20');
    expect(caption).not.toContain('minute');
  });

  it('keeps a real nick and does not invent the word player', () => {
    const caption = buildMatchCaption({
      mapName: 'mp_carentan',
      axis: 1,
      allies: 3,
      players: [
        player({
          name: '^0Persian^1Gulf',
          num: 2,
          score: 86,
          minutes: 13.87,
          team: 2,
        }),
        player({ name: 'Вика', num: 8, score: 74, minutes: 14, team: 1 }),
        player({ name: '^1^7', num: 11, score: 35, minutes: 13, team: 2 }),
      ],
    });
    expect(caption).toContain('1. PersianGulf — 86');
    expect(caption).toContain('2. Вика — 74');
    expect(caption).toContain('3. #11 — 35');
    expect(caption).toContain('1. PersianGulf — 86 points in 14 min');
    expect(caption).toContain('2. Вика — 74 points in 14 min');
    expect(caption).not.toContain('player');
    expect(caption).not.toContain('/min');
  });
});

describe('resolveMapPreview', () => {
  it('uses the first screenshot that exists and rejects an unsafe name', () => {
    const seen: string[] = [];
    const found = resolveMapPreview(
      'mp_toujane',
      ['/bundle', '/checkout'],
      (file) => {
        seen.push(file);
        return file === '/checkout/mp_toujane.webp';
      },
    );
    expect(found).toBe('/checkout/mp_toujane.webp');
    expect(seen).toEqual([
      '/bundle/mp_toujane.webp',
      '/checkout/mp_toujane.webp',
    ]);
    expect(
      resolveMapPreview('../etc/passwd', ['/bundle'], () => true),
    ).toBeNull();
    expect(resolveMapPreview('mp toujane', ['/bundle'], () => true)).toBeNull();
  });
});
