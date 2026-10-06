import { describe, expect, it } from 'vitest';
import { cleanBanFileName, isBanFileSafeName } from './ban-file.js';

describe('cleanBanFileName', () => {
  it.each([
    ['Plain', 'Plain'],
    ['Two Words', 'Two Words'],
    ['^1Color^7Name', 'ColorName'],
    ['Вика', ''],
    ['ВикаMixed', 'Mixed'],
    ['^^20Persian^^51Gulf^7', '^0Persian^1Gulf'],
    ['trailing^', 'trailing^'],
  ])('cleans %j to %j, the way the game writes it to ban.txt', (name, expected) => {
    expect(cleanBanFileName(name)).toBe(expected);
  });
});

describe('isBanFileSafeName', () => {
  it.each([
    ['Plain', true],
    ['^1Color^7Name', true],
    ['ВикаMixed', true],
    ['Вика', false],
    ['^1', false],
    ['Вика Mixed', false],
    ['Mixed Вика', false],
  ])('%j → %s', (name, expected) => {
    expect(isBanFileSafeName(name)).toBe(expected);
  });
});
