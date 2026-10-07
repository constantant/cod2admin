import type { StatusPlayer } from '@cod2admin/rcon-client';
import type { InputFile } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import {
  displayName,
  formatPlayersMessage,
  formatPlayersReport,
  formatPlayersSummary,
  playersCommand,
  type PlayerIpLookups,
} from './players.js';

const PLAYER: StatusPlayer = { num: 3, score: 5, ping: 42, name: 'PlayerOne', ip: '123.45.67.89' };

describe('formatPlayersMessage', () => {
  it('formats one line per player with num/name/score/ping/ip', () => {
    expect(formatPlayersMessage([PLAYER])).toBe('#3 PlayerOne — score 5, ping 42, ip 123.45.67.89');
  });

  it('adds the IP country when it is known', () => {
    const geoip = { lookup: (ip: string) => (ip === '123.45.67.89' ? { code: 'RU', name: 'Russia' } : undefined) };

    expect(formatPlayersMessage([PLAYER, { ...PLAYER, num: 4, ip: '9.9.9.9' }], { geoip })).toBe(
      ['#3 PlayerOne — score 5, ping 42, ip 123.45.67.89 🇷🇺 RU', '#4 PlayerOne — score 5, ping 42, ip 9.9.9.9'].join('\n'),
    );
  });

  it('adds the VPN flag after the country when the IP is flagged', () => {
    const geoip = { lookup: () => ({ code: 'NL', name: 'Netherlands' }) };
    const vpn = { lookup: (ip: string) => (ip === '123.45.67.89' ? ('vpn' as const) : undefined) };

    expect(formatPlayersMessage([PLAYER, { ...PLAYER, num: 4, ip: '9.9.9.9' }], { geoip, vpn })).toBe(
      ['#3 PlayerOne — score 5, ping 42, ip 123.45.67.89 🇳🇱 NL 🛡 VPN', '#4 PlayerOne — score 5, ping 42, ip 9.9.9.9 🇳🇱 NL'].join(
        '\n',
      ),
    );
  });

  it('adds the provider after the country, cut to fit, and before the VPN flag', () => {
    const geoip = { lookup: () => ({ code: 'RU', name: 'Russia' }) };
    const provider = {
      lookup: (ip: string) =>
        ip === '123.45.67.89' ? 'PJSC Rostelecom' : 'SOCIETE NATIONALE DES TELECOMMUNICATIONS (Tunisie Telecom)',
      asn: () => undefined,
    };
    const vpn = { lookup: (ip: string) => (ip === '9.9.9.9' ? ('hosting' as const) : undefined) };

    expect(formatPlayersMessage([PLAYER, { ...PLAYER, num: 4, ip: '9.9.9.9' }], { geoip, provider, vpn })).toBe(
      [
        '#3 PlayerOne — score 5, ping 42, ip 123.45.67.89 🇷🇺 RU · PJSC Rostelecom',
        '#4 PlayerOne — score 5, ping 42, ip 9.9.9.9 🇷🇺 RU · SOCIETE NATIONALE DES TE… 🛡 hosting',
      ].join('\n'),
    );
  });

  it('shows the provider alone when the country is unknown', () => {
    const provider = { lookup: () => 'OBIT Ltd.', asn: () => 8492 };

    expect(formatPlayersMessage([PLAYER], { provider })).toBe('#3 PlayerOne — score 5, ping 42, ip 123.45.67.89 OBIT Ltd.');
  });

  it('reports no players connected when the list is empty', () => {
    expect(formatPlayersMessage([])).toBe('No players connected.');
  });
});

describe('playersCommand', () => {
  it('replies with the formatted player list from status()', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [PLAYER] });
    const ctx = createFakeCtx();

    await playersCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(formatPlayersMessage([PLAYER]));
    expect(ctx.replyWithDocument).not.toHaveBeenCalled();
  });

  it('sends a full server as a summary plus an attached report, never over the message limit', async () => {
    const { deps, rcon } = createFakeDeps();
    const players: StatusPlayer[] = Array.from({ length: 40 }, (_, i) => ({
      num: i,
      score: 30,
      ping: 120,
      guid: i % 3 === 0 ? String(700000 + i) : '0',
      name: `^1Very^7LongPlayerName${i}^3!`,
      ip: `188.19.${i}.200`,
    }));
    rcon.status.mockResolvedValue({ raw: '', players, mapName: 'mp_toujane' });
    deps.geoip = { lookup: () => ({ code: 'RU', name: 'Russia', city: 'Khanty-Mansiysk', region: 'Khanty-Mansia' }) };
    deps.provider = { lookup: () => 'SOCIETE NATIONALE DES TELECOMMUNICATIONS (Tunisie Telecom)', asn: () => 12389 };
    const ctx = createFakeCtx();

    await playersCommand(ctx, deps);

    // The old one-message format would be far over Telegram's limit here.
    expect(formatPlayersMessage(players, deps).length).toBeGreaterThan(4096);
    const sentTexts = vi.mocked(ctx.reply).mock.calls.map(([text]) => text);
    const [file, other] = vi.mocked(ctx.replyWithDocument!).mock.calls[0]!;
    for (const text of [...sentTexts, (other as { caption?: string } | undefined)?.caption ?? '']) {
      expect(text.length).toBeLessThanOrEqual(4096);
    }
    expect((file as InputFile).filename).toMatch(/^players-default-\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  });
});

describe('players summary and report', () => {
  const CONTEXT = { serverAlias: 'ctfrussia', mapName: 'mp_toujane' };
  const NOW = new Date('2026-10-07T10:23:00Z');
  const players: StatusPlayer[] = [
    { num: 0, score: 36, ping: 74, name: 'hutu boy^7', ip: '178.73.57.1', guid: '951247' },
    { num: 13, score: 5, ping: 60, name: 'const', ip: '2.27.5.10', guid: '0' },
    { num: 8, score: 1, ping: 40, name: 'XMAO|SURGUT', ip: '188.19.61.1' },
  ];
  const lookups: PlayerIpLookups = {
    geoip: {
      lookup: (ip) =>
        ip.startsWith('188.')
          ? { code: 'RU', name: 'Russia', city: 'Khanty-Mansiysk', region: 'Khanty-Mansia' }
          : { code: 'PL', name: 'Poland' },
    },
    provider: {
      lookup: (ip) => (ip.startsWith('2.27.') ? 'Great Flower' : 'PJSC Rostelecom'),
      asn: (ip) => (ip.startsWith('2.27.') ? 202226 : 12389),
    },
    vpn: { lookup: (ip) => (ip.startsWith('2.27.') ? ('provider' as const) : undefined) },
  };

  it('summarises players by country and VPN, one short line each, without colour codes', () => {
    expect(formatPlayersSummary(players, lookups, CONTEXT)).toBe(
      [
        '3 players · ctfrussia · mp_toujane',
        '🇵🇱 2  🇷🇺 1',
        '🛡 1 on VPN/proxy/Tor',
        '',
        '#0 hutu boy 🇵🇱',
        '#13 const 🇵🇱 🛡',
        '#8 XMAO|SURGUT 🇷🇺',
        '',
        'Full details (IP, city, provider, GUID) in the attached file.',
      ].join('\n'),
    );
  });

  it('builds a report table with everything the bot knows, escaping names', () => {
    const report = formatPlayersReport(players, lookups, CONTEXT, NOW);

    expect(report).toContain('# Players — ctfrussia');
    expect(report).toContain('- Map: mp_toujane');
    expect(report).toContain('| # | Name | Score | Ping | GUID | IP | Location | Provider | VPN |');
    expect(report).toContain('| 0 | hutu boy | 36 | 74 | 951247 | 178.73.57.1 | 🇵🇱 Poland | PJSC Rostelecom (AS12389) | — |');
    expect(report).toContain('| 13 | const | 5 | 60 | 0 | 2.27.5.10 | 🇵🇱 Poland | Great Flower (AS202226) | 🛡 VPN (provider on /vpnnets) |');
    expect(report).toContain('| 8 | XMAO\\|SURGUT | 1 | 40 | 0 | 188.19.61.1 | 🇷🇺 Russia, Khanty-Mansiysk (Khanty-Mansia) |');
    expect(report).toContain('DB-IP.com');
  });

  it('strips colour codes from names in the plain list too', () => {
    expect(formatPlayersMessage([{ ...PLAYER, name: '^3Ala^5ddin^7' }])).toBe(
      '#3 Aladdin — score 5, ping 42, ip 123.45.67.89',
    );
  });

  it.each([
    ['^^11Mahdi^^22EniGmA^7', 'MahdiEniGmA'],
    ['^^00Pjoter^^99x^^11D^7', 'PjoterxD'],
    ['^7', 'client 3'],
  ])('strips doubled colour codes: %s → %s', (name, expected) => {
    expect(displayName({ ...PLAYER, name })).toBe(expected);
  });
});
