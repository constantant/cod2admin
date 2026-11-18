import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CustomFunctionDefinition } from '@cod2admin/admin-store';
import { describe, expect, it } from 'vitest';
import {
  FunctionError,
  needsContext,
  parseCvarReply,
  parseDefinition,
  parseFunctionInput,
  resolveSetting,
  resolveSteps,
} from './custom-functions.js';

const action = (definition: unknown, kind = 'action') => ({
  slug: 'give',
  title: 'Give',
  kind,
  definition,
});

describe('parseFunctionInput', () => {
  it('accepts an action and fills the defaults', () => {
    const parsed = parseFunctionInput(
      action({
        params: [{ name: 'text', label: 'Text', type: 'text' }],
        steps: ['say {text}'],
      }),
    );
    expect(parsed).toMatchObject({
      slug: 'give',
      kind: 'action',
      serverAlias: null,
      requires: null,
      dangerous: false,
      enabled: true,
    });
  });

  it.each([
    [
      'a bad slug',
      { ...action({ params: [], steps: ['x'] }), slug: 'No Good' },
    ],
    ['an unknown kind', action({ params: [], steps: ['x'] }, 'macro')],
    [
      'requiring functions.manage',
      { ...action({ params: [], steps: ['x'] }), requires: 'functions.manage' },
    ],
    [
      'an unknown permission',
      { ...action({ params: [], steps: ['x'] }), requires: 'nope' },
    ],
    ['a bad icon', { ...action({ params: [], steps: ['x'] }), icon: 'a b' }],
  ])('rejects %s', (_name, body) => {
    expect(() => parseFunctionInput(body)).toThrow(FunctionError);
  });
});

describe('parseDefinition', () => {
  const text = { name: 'msg', label: 'Message', type: 'text' } as const;

  it.each([
    ['no steps', { params: [], steps: [] }],
    ['too many steps', { params: [], steps: Array(6).fill('x') }],
    ['a second command after ;', { params: [], steps: ['say a; quit'] }],
    ['a line break', { params: [], steps: ['say a\nquit'] }],
    ['the rcon password', { params: [], steps: ['set rcon_password x'] }],
    ['an unknown placeholder', { params: [], steps: ['say {nope}'] }],
    ['an unused parameter', { params: [text], steps: ['say hi'] }],
    ['a repeated parameter', { params: [text, text], steps: ['say {msg}'] }],
    ['a quoted text placeholder', { params: [text], steps: ['say "{msg}"'] }],
    [
      'a choice value with a space',
      {
        params: [
          {
            name: 'w',
            label: 'W',
            type: 'choice',
            options: [{ value: 'a b', label: 'A' }],
          },
        ],
        steps: ['give {w}'],
      },
    ],
    [
      'min above max',
      {
        params: [{ name: 'n', label: 'N', type: 'number', min: 5, max: 1 }],
        steps: ['x {n}'],
      },
    ],
    [
      'a bad parameter name',
      { params: [{ name: 'Bad', label: 'B', type: 'text' }], steps: ['x'] },
    ],
  ])('rejects %s', (_name, definition) => {
    expect(() => parseDefinition('action', definition)).toThrow(FunctionError);
  });

  it('keeps "player" for the player menu', () => {
    expect(() =>
      parseDefinition('player_action', {
        params: [{ name: 'player', label: 'P', type: 'text' }],
        steps: ['x {player}'],
      }),
    ).toThrow(/player/);
    expect(() =>
      parseDefinition('player_action', { params: [], steps: ['say hi'] }),
    ).toThrow(/\{player\}/);
  });

  it('validates a setting', () => {
    expect(
      parseDefinition('setting', {
        cvar: 'g_gravity',
        control: { type: 'number', min: 100, max: 1000 },
      }),
    ).toEqual({
      cvar: 'g_gravity',
      control: { type: 'number', min: 100, max: 1000 },
    });
    expect(() =>
      parseDefinition('setting', {
        cvar: 'rcon_password',
        control: { type: 'text' },
      }),
    ).toThrow(FunctionError);
    expect(() =>
      parseDefinition('setting', { cvar: 'a b', control: { type: 'text' } }),
    ).toThrow(FunctionError);
  });
});

describe('resolveSteps', () => {
  const definition: CustomFunctionDefinition = {
    params: [
      { name: 'msg', label: 'Message', type: 'text' },
      { name: 'n', label: 'Amount', type: 'number', min: 1, max: 10 },
      {
        name: 'w',
        label: 'Weapon',
        type: 'choice',
        options: [{ value: 'ak47', label: 'AK' }],
      },
      { name: 'on', label: 'On', type: 'bool', onValue: 'yes', offValue: 'no' },
      { name: 'who', label: 'Who', type: 'player' },
      { name: 'm', label: 'Map', type: 'map' },
    ],
    steps: ['say {msg}', 'give {who} {w} {n} {on} {m}'],
  };
  const fn = { kind: 'action' as const, definition };
  const context = {
    players: [{ num: 3, name: 'Vika' }],
    maps: ['mp_toujane'],
  };
  const values = {
    msg: 'Привет мир',
    n: 4,
    w: 'ak47',
    on: true,
    who: { num: 3, name: 'Vika' },
    m: 'mp_toujane',
  };

  it('quotes text, and passes the rest as validated tokens', () => {
    expect(resolveSteps(fn, values, context)).toEqual([
      'say "Привет мир"',
      'give 3 ak47 4 yes mp_toujane',
    ]);
  });

  it('strips what could end the string or start another command', () => {
    expect(
      resolveSteps(fn, { ...values, msg: 'hi"; quit\nrcon' }, context)[0],
    ).toBe('say "hi quitrcon"');
  });

  it.each([
    ['empty text', { msg: '   ' }],
    ['a number out of range', { n: 11 }],
    ['a fractional number', { n: 1.5 }],
    ['a number that is not one', { n: 'abc' }],
    ['a choice not on the list', { w: 'ak47; quit' }],
    ['a bool that is not boolean', { on: 'yes' }],
    ['a player gone from the slot', { who: { num: 3, name: 'Other' } }],
    ['a player that is just a number', { who: 3 }],
    ['an uninstalled map', { m: 'mp_other' }],
  ])('refuses %s', (_name, override) => {
    expect(() => resolveSteps(fn, { ...values, ...override }, context)).toThrow(
      FunctionError,
    );
  });

  it('refuses a stored definition that no longer validates', () => {
    expect(() =>
      resolveSteps(
        { kind: 'action', definition: { params: [], steps: ['say a; quit'] } },
        {},
      ),
    ).toThrow(FunctionError);
  });

  it('fills {player} for a player action', () => {
    expect(
      resolveSteps(
        {
          kind: 'player_action',
          definition: { params: [], steps: ['scr_give {player} ak47'] },
        },
        { player: { num: 3, name: 'Vika' } },
        context,
      ),
    ).toEqual(['scr_give 3 ak47']);
  });

  it('says what live data it will need', () => {
    expect(needsContext(fn)).toEqual({ players: true, maps: true });
    expect(
      needsContext({
        kind: 'player_action',
        definition: { params: [], steps: ['x {player}'] },
      }),
    ).toEqual({ players: true, maps: false });
    expect(
      needsContext({
        kind: 'setting',
        definition: { cvar: 'a', control: { type: 'text' } },
      }),
    ).toEqual({ players: false, maps: false });
  });
});

describe('resolveSetting', () => {
  const make = (control: unknown) => ({
    kind: 'setting' as const,
    definition: { cvar: 'g_x', control } as never,
  });

  it('maps a toggle to its values', () => {
    expect(resolveSetting(make({ type: 'toggle' }), true)).toEqual({
      cvar: 'g_x',
      value: '1',
    });
    expect(
      resolveSetting(make({ type: 'toggle', offValue: 'off' }), false),
    ).toEqual({ cvar: 'g_x', value: 'off' });
  });

  it('checks numbers, selects and text', () => {
    expect(
      resolveSetting(make({ type: 'number', min: 1, max: 5 }), '3').value,
    ).toBe('3');
    expect(() =>
      resolveSetting(make({ type: 'number', min: 1, max: 5 }), 9),
    ).toThrow(FunctionError);
    expect(() =>
      resolveSetting(
        make({ type: 'select', options: [{ value: 'a', label: 'A' }] }),
        'b',
      ),
    ).toThrow(FunctionError);
    expect(resolveSetting(make({ type: 'text' }), 'a"b;c').value).toBe('abc');
  });
});

describe('parseCvarReply', () => {
  it('reads the value and drops the colour reset', () => {
    expect(
      parseCvarReply('"g_gravity" is:"800^7" default:"800^7"\n', 'g_gravity'),
    ).toBe('800');
    expect(parseCvarReply('"x" is:"a b^7", the default', 'X')).toBe('a b');
    expect(parseCvarReply('"x" is:""', 'x')).toBe('');
  });

  it('says nothing for a reply that is not about that cvar', () => {
    expect(parseCvarReply('', 'x')).toBeNull();
    expect(parseCvarReply('Cvar x is not set', 'x')).toBeNull();
    expect(parseCvarReply('"y" is:"1^7"', 'x')).toBeNull();
  });
});

describe('the example pack in docs/examples', () => {
  const pack = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../../../docs/examples/custom-functions.json',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  ) as { format: string; functions: unknown[] };

  it('is a pack every function of which passes the same checks as one made by hand', () => {
    expect(pack.format).toBe('cod2admin-functions');
    expect(pack.functions).toHaveLength(3);
    for (const entry of pack.functions) {
      expect(() => parseFunctionInput(entry)).not.toThrow();
    }
  });
});
