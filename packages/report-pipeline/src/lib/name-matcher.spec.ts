import { describe, expect, it } from 'vitest';
import { matchPlayersByName } from './name-matcher.js';

describe('matchPlayersByName', () => {
  it('matches case-insensitively', () => {
    expect(matchPlayersByName('bob', ['Bob', 'Alice'], (n) => n)).toEqual(['Bob']);
  });

  it('prefers an exact match over players whose names merely contain it', () => {
    expect(matchPlayersByName('Bob', ['Bob', 'Bobby'], (n) => n)).toEqual(['Bob']);
  });

  it('falls back to substring containment when there is no exact match', () => {
    expect(matchPlayersByName('bob', ['Bobby', 'Alice'], (n) => n)).toEqual(['Bobby']);
  });

  it('returns every substring match when several qualify (the ambiguous case)', () => {
    expect(matchPlayersByName('bob', ['Bobby', 'BobTheBuilder', 'Alice'], (n) => n)).toEqual([
      'Bobby',
      'BobTheBuilder',
    ]);
  });

  it('returns an empty array for an empty/whitespace-only target', () => {
    expect(matchPlayersByName('', ['Bob'], (n) => n)).toEqual([]);
    expect(matchPlayersByName('   ', ['Bob'], (n) => n)).toEqual([]);
  });

  it('never matches a candidate with an empty name (the just-connected quirk, docs/PLAN.md §2.4)', () => {
    expect(matchPlayersByName('bob', ['', 'Bob'], (n) => n)).toEqual(['Bob']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(matchPlayersByName('zzz', ['Bob', 'Alice'], (n) => n)).toEqual([]);
  });
});
