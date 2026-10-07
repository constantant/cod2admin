import { parseColoredName, plainName } from './game-name';

describe('parseColoredName', () => {
  it('splits a name into its ^N colour runs', () => {
    expect(parseColoredName('^1Red^7Baron')).toEqual([
      { text: 'Red', color: '1' },
      { text: 'Baron', color: null },
    ]);
  });

  it('shows ^0 and ^7 in the normal text colour, merging neighbouring runs', () => {
    expect(parseColoredName('^0A^7B')).toEqual([{ text: 'AB', color: null }]);
  });

  it('drops the doubled ^^11 form, as the bot does', () => {
    expect(parseColoredName('^^11Pro^^22')).toEqual([{ text: 'Pro', color: null }]);
  });

  it('keeps plain and Cyrillic names whole', () => {
    expect(parseColoredName('Вика')).toEqual([{ text: 'Вика', color: null }]);
    expect(parseColoredName('')).toEqual([]);
  });
});

describe('plainName', () => {
  it('is the name without colour codes', () => {
    expect(plainName('^4Blue^3Fox ')).toBe('BlueFox');
  });
});
