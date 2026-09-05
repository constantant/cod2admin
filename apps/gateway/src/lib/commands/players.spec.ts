import type { StatusPlayer } from '@cod2admin/rcon-client';
import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { formatPlayersMessage, playersCommand } from './players.js';

const PLAYER: StatusPlayer = { num: 3, score: 5, ping: 42, name: 'PlayerOne', ip: '123.45.67.89' };

describe('formatPlayersMessage', () => {
  it('formats one line per player with num/name/score/ping/ip', () => {
    expect(formatPlayersMessage([PLAYER])).toBe('#3 PlayerOne — score 5, ping 42, ip 123.45.67.89');
  });

  it('reports no players connected when the list is empty', () => {
    expect(formatPlayersMessage([])).toBe('No players connected.');
  });
});

describe('playersCommand', () => {
  it('replies with the formatted player list from status()', async () => {
    const fake = createFakeRcon();
    fake.status.mockResolvedValue({ raw: '', players: [PLAYER] });
    const ctx = createFakeCtx();

    await playersCommand(ctx, asRconClient(fake));

    expect(ctx.reply).toHaveBeenCalledWith(formatPlayersMessage([PLAYER]));
  });
});
