import { DumpuserReplyError, type StatusPlayer } from '@cod2admin/rcon-client';
import { describe, expect, it, vi } from 'vitest';
import {
  createPlayerIdentityResolver,
  playerIdentityKey,
} from './player-identity.js';

function player(overrides: Partial<StatusPlayer> = {}): StatusPlayer {
  return {
    num: 3,
    score: 0,
    ping: 0,
    name: '^1const^7',
    guid: '0',
    ip: '1.2.3.4',
    ...overrides,
  };
}

const PLAYER = player();

describe('playerIdentityKey', () => {
  it('uses a non-zero signed cl_hwid, and never hwid 0 or guid 0', () => {
    expect(playerIdentityKey(PLAYER, { cl_hwid: '-2031228850' })).toBe(
      'hwid:-2031228850',
    );
    expect(playerIdentityKey(PLAYER, { cl_hwid: '2031228850' })).toBe(
      'hwid:2031228850',
    );
    expect(playerIdentityKey(PLAYER, { cl_hwid: '0' })).toBe('ip:1.2.3.4');
    expect(playerIdentityKey(PLAYER, { cl_hwid: '00' })).toBe('ip:1.2.3.4');
    expect(playerIdentityKey(PLAYER, { cl_hwid: 'nope' })).toBe('ip:1.2.3.4');
    expect(playerIdentityKey(player({ guid: '42' }))).toBe('guid:42');
    expect(playerIdentityKey(player({ guid: ' 0 ' }))).toBe('ip:1.2.3.4');
    expect(playerIdentityKey({ guid: '0', ip: '10.0.0.5' })).toBe(
      'ip:10.0.0.5',
    );
    expect(playerIdentityKey({ guid: '0' })).toBeNull();
    expect(
      playerIdentityKey(PLAYER, { cl_hwid: '0', cl_hwid2: 'abc' }),
    ).not.toBe('hwid:0');
    expect(playerIdentityKey(PLAYER)).not.toBe('guid:0');
  });

  it('uses a dumpuser map the caller already has', () => {
    expect(playerIdentityKey(player({ guid: '42' }), { cl_hwid: '0' })).toBe(
      'guid:42',
    );
  });
});

describe('createPlayerIdentityResolver', () => {
  it('does not call RCON until resolve, and strips the name it passes to dumpuser', async () => {
    let time = 10_000;
    const dumpuser = vi.fn(async () => ({ cl_hwid: '7' }));
    const status = vi.fn();
    const resolver = createPlayerIdentityResolver({
      now: () => time,
      dumpuser,
      status,
    });

    expect(dumpuser).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();

    const resolved = await resolver.resolve({
      serverAlias: 'ctf',
      player: PLAYER,
      statusFetchedAt: 10_000,
    });

    expect(resolved.key).toBe('hwid:7');
    expect(resolved.dumpuserSkipped).toBe(false);
    expect(dumpuser).toHaveBeenCalledTimes(1);
    expect(dumpuser).toHaveBeenCalledWith('ctf', 'const');
    expect(dumpuser.mock.calls[0]?.[1]).not.toBe('3');
    expect(status).not.toHaveBeenCalled();
  });

  it('refuses dumpuser within a second and does not invent an hwid', async () => {
    let time = 5_000;
    const dumpuser = vi.fn(async () => ({ cl_hwid: '42' }));
    const resolver = createPlayerIdentityResolver({
      now: () => time,
      dumpuser,
    });
    const input = {
      serverAlias: 'ctf',
      player: PLAYER,
      statusFetchedAt: 5_000,
    };

    await resolver.resolve(input);
    const skipped = await resolver.resolve(input);

    expect(skipped.key).toBe('ip:1.2.3.4');
    expect(skipped.dumpuserSkipped).toBe(true);
    expect(dumpuser).toHaveBeenCalledTimes(1);

    time = 6_000;
    const again = await resolver.resolve(input);
    expect(again.key).toBe('hwid:42');
    expect(dumpuser).toHaveBeenCalledTimes(2);
  });

  it('holds the budget for an in-flight command, then one second after it settles', async () => {
    let time = 1_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dumpuser = vi.fn(() => gate.then(() => ({ cl_hwid: '1' })));
    const resolver = createPlayerIdentityResolver({
      now: () => time,
      dumpuser,
    });
    const input = {
      serverAlias: 'ctf',
      player: PLAYER,
      statusFetchedAt: 1_000,
    };

    const first = resolver.resolve(input);
    expect(dumpuser).toHaveBeenCalledTimes(1);

    time = 50_000;
    const during = await resolver.resolve(input);
    expect(during.dumpuserSkipped).toBe(true);
    expect(during.key).toBe('ip:1.2.3.4');
    expect(dumpuser).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ key: 'hwid:1' });

    const settled = await resolver.resolve(input);
    expect(settled.dumpuserSkipped).toBe(true);
    expect(dumpuser).toHaveBeenCalledTimes(1);

    time = 51_000;
    const later = await resolver.resolve(input);
    expect(later.key).toBe('hwid:1');
    expect(dumpuser).toHaveBeenCalledTimes(2);
  });

  it('budgets each server on its own', async () => {
    const dumpuser = vi.fn(async () => ({ cl_hwid: '1' }));
    const resolver = createPlayerIdentityResolver({
      now: () => 1_000,
      dumpuser,
    });
    const input = { player: PLAYER, statusFetchedAt: 1_000 };

    await resolver.resolve({ ...input, serverAlias: 'a' });
    await resolver.resolve({ ...input, serverAlias: 'b' });
    const blocked = await resolver.resolve({ ...input, serverAlias: 'a' });

    expect(dumpuser).toHaveBeenCalledTimes(2);
    expect(dumpuser).toHaveBeenNthCalledWith(1, 'a', 'const');
    expect(dumpuser).toHaveBeenNthCalledWith(2, 'b', 'const');
    expect(blocked.dumpuserSkipped).toBe(true);
    expect(blocked.key).toBe('ip:1.2.3.4');
  });

  it('keeps guid or ip when dumpuser times out, without logging it', async () => {
    let time = 0;
    const dumpuser = vi.fn(async () => {
      throw new Error('timed out');
    });
    const resolver = createPlayerIdentityResolver({
      now: () => time,
      dumpuser,
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const failed = await resolver.resolve({
        serverAlias: 'ctf',
        player: player({ guid: '99', ip: '8.8.8.8' }),
        statusFetchedAt: 0,
      });
      expect(failed.key).toBe('guid:99');
      expect(failed.dumpuserSkipped).toBe(false);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }

    time = 1_000;
    dumpuser.mockResolvedValueOnce({});
    const missed = await resolver.resolve({
      serverAlias: 'ctf',
      player: PLAYER,
      statusFetchedAt: 1_000,
    });
    expect(missed.key).toBe('ip:1.2.3.4');
    expect(missed.key).not.toMatch(/^hwid:/);
  });

  it('logs a dumpuser layout miss and still keys by guid or ip', async () => {
    const dumpuser = vi.fn(async () => {
      throw new DumpuserReplyError('userinfo\nnot a cvar');
    });
    const resolver = createPlayerIdentityResolver({
      now: () => 0,
      dumpuser,
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const resolved = await resolver.resolve({
        serverAlias: 'ctf',
        player: player({ guid: '99' }),
        statusFetchedAt: 0,
      });
      expect(resolved.key).toBe('guid:99');
      expect(resolved.key).not.toMatch(/^hwid:/);
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it('does not status a row from the last 10 seconds', async () => {
    const status = vi.fn();
    const dumpuser = vi.fn(async () => ({ cl_hwid: '4' }));
    const resolver = createPlayerIdentityResolver({
      now: () => 10_000,
      dumpuser,
      status,
    });

    const resolved = await resolver.resolve({
      serverAlias: 'ctf',
      player: player({ guid: '15' }),
      statusFetchedAt: 0,
    });

    expect(status).not.toHaveBeenCalled();
    expect(dumpuser).toHaveBeenCalledTimes(1);
    expect(resolved.key).toBe('hwid:4');
    expect(resolved.statusFetchedAt).toBe(0);
  });

  it('spends a stale row on status and dumpuser only on a later second', async () => {
    let time = 10_001;
    const status = vi.fn(async () => ({
      players: [
        player({ num: 3, name: 'const', guid: '55', ip: '1.2.3.4' }),
        player({ num: 4, name: 'other', guid: '0', ip: '9.9.9.9' }),
      ],
    }));
    const dumpuser = vi.fn(async () => ({ cl_hwid: '-8' }));
    const resolver = createPlayerIdentityResolver({
      now: () => time,
      dumpuser,
      status,
    });

    const refreshed = await resolver.resolve({
      serverAlias: 'ctf',
      player: PLAYER,
      statusFetchedAt: 0,
    });

    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith('ctf');
    expect(dumpuser).not.toHaveBeenCalled();
    expect(refreshed.dumpuserSkipped).toBe(true);
    expect(refreshed.key).toBe('guid:55');
    expect(refreshed.player.num).toBe(3);
    expect(refreshed.statusFetchedAt).toBe(10_001);

    time = 11_001;
    const keyed = await resolver.resolve({
      serverAlias: 'ctf',
      player: refreshed.player,
      statusFetchedAt: refreshed.statusFetchedAt,
    });

    expect(status).toHaveBeenCalledTimes(1);
    expect(dumpuser).toHaveBeenCalledTimes(1);
    expect(dumpuser).toHaveBeenCalledWith('ctf', 'const');
    expect(keyed.key).toBe('hwid:-8');
  });

  it('does not status or dumpuser while the last identity command was under a second ago', async () => {
    let time = 20_000;
    const status = vi.fn();
    const dumpuser = vi.fn(async () => ({ cl_hwid: '1' }));
    const resolver = createPlayerIdentityResolver({
      now: () => time,
      dumpuser,
      status,
    });

    await resolver.resolve({
      serverAlias: 'ctf',
      player: player({ guid: '3' }),
      statusFetchedAt: 20_000,
    });
    const blocked = await resolver.resolve({
      serverAlias: 'ctf',
      player: PLAYER,
      statusFetchedAt: 0,
    });

    expect(dumpuser).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(blocked.dumpuserSkipped).toBe(true);
    expect(blocked.key).toBe('ip:1.2.3.4');
  });
});
