import type { StatusPlayer } from '@cod2admin/rcon-client';
import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { formatPlayersMessage, playersCommand } from './players.js';

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
    const provider = { lookup: () => 'OBIT Ltd.' };

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
  });
});
