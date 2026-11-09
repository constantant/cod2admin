/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ruSpan } from './i18n-ru';
import { translate } from './i18n';

const APP_DIR = ['src/app', 'apps/miniapp-web/src/app']
  .map((dir) => join(process.cwd(), dir))
  .find((dir) => existsSync(dir))!;
/** Names and examples: the same in Russian. */
const SAME_IN_RUSSIAN = new Set([
  'AS',
  'AS202226',
  'AS12389',
  'AS12389 / guid:716922',
  'GUID',
  'ID',
  'IP',
  'v',
  '· ID',
  'https://my-relay.deno.dev',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(ts|html)$/.test(name) && !/\.spec\.ts$|i18n/.test(name)
      ? [path]
      : [];
  });
}

/** Every `'text' | t` and `"text" | t` in the templates. */
function templateTexts(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(APP_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const [, single, double] of source.matchAll(
      /(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\|\s*t\b/g,
    )) {
      found.add((single ?? double).replace(/\\'/g, "'").replace(/\s+/g, ' '));
    }
  }
  return [...found];
}

describe('translate', () => {
  it('leaves English alone, and unknown text as it is', () => {
    expect(translate('Players', 'en')).toBe('Players');
    expect(translate('Some new text', 'ru')).toBe('Some new text');
  });

  it('finds whole texts, ignoring how a template wrapped the lines', () => {
    expect(translate('Players', 'ru')).toBe('Игроки');
    expect(translate('  Nobody is\n    playing right now. ', 'ru')).toBe(
      'Сейчас никто не играет.',
    );
  });

  it('fills in texts with something variable in them', () => {
    expect(translate('Kicked ^1Bad.', 'ru')).toBe('^1Bad кикнут.');
    expect(translate('Temp-banned Bob for 2h.', 'ru')).toBe(
      'Bob забанен на 2ч.',
    );
    expect(translate('IP-banned (GUID unavailable) Bob.', 'ru')).toBe(
      'Bob забанен по IP (нет GUID).',
    );
    expect(translate('30m', 'ru')).toBe('30м');
    expect(translate('2h 30m ago', 'ru')).toBe('2ч 30м назад');
    expect(translate('This needs the ban permission.', 'ru')).toBe(
      'Нужно право «Бан».',
    );
    expect(translate('This needs the cvars.read permission.', 'ru')).toBe(
      'Нужно право «Смотреть настройки».',
    );
    expect(translate("You can't grant servers.manage.", 'ru')).toBe(
      'Вы не можете выдать право «Добавлять и убирать серверы».',
    );
  });

  it.each([
    ['1 players', '1 игрок'],
    ['3 players', '3 игрока'],
    ['5 players', '5 игроков'],
    ['11 players', '11 игроков'],
    ['21 players', '21 игрок'],
  ])('uses the right word form: %s', (english, russian) => {
    expect(translate(english, 'ru')).toBe(russian);
  });

  it('writes lengths with Russian units', () => {
    expect(ruSpan('3d 4h')).toBe('3д 4ч');
    expect(ruSpan('45m')).toBe('45м');
  });

  it('has a translation for every text in the templates', () => {
    const missing = templateTexts().filter(
      (text) =>
        /[A-Za-z]/.test(text) &&
        !SAME_IN_RUSSIAN.has(text) &&
        translate(text, 'ru') === text,
    );

    expect(missing).toEqual([]);
  });
});
