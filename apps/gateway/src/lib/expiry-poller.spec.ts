import type { BanIp } from '@cod2admin/ban-store';
import {
  UdpQueryTimeoutError,
  type ServerStatus,
} from '@cod2admin/rcon-client';
import { describe, expect, it, vi } from 'vitest';
import { runSweepRound, shareStatusPerRound } from './expiry-poller.js';
import { createFakeDeps } from './testing/fake-deps.js';
import { asRconClient, createFakeRcon } from './testing/fake-rcon.js';

const STATUS: ServerStatus = {
  raw: '',
  players: [
    {
      num: 3,
      score: 0,
      ping: 50,
      guid: '0',
      name: 'Banned',
      lastmsg: 0,
      ip: '203.0.113.7',
      port: 28960,
      qport: 1,
    },
  ],
};

describe('shareStatusPerRound', () => {
  it('asks the server for status once, however many callers', async () => {
    const rcon = createFakeRcon();
    rcon.status.mockResolvedValue(STATUS);
    const shared = shareStatusPerRound(
      new Map([['default', asRconClient(rcon)]]),
    );
    const client = shared.get('default')!;

    const [a, b, c] = await Promise.all([
      client.status(),
      client.status(),
      client.status(),
    ]);

    expect(rcon.status).toHaveBeenCalledTimes(1);
    expect(a).toBe(STATUS);
    expect(b).toBe(STATUS);
    expect(c).toBe(STATUS);
  });

  it('shares a failure too, so a dead server is retried once per round', async () => {
    const rcon = createFakeRcon();
    rcon.status.mockRejectedValue(new Error('timed out'));
    const client = shareStatusPerRound(
      new Map([['default', asRconClient(rcon)]]),
    ).get('default')!;

    await expect(client.status()).rejects.toThrow('timed out');
    await expect(client.status()).rejects.toThrow('timed out');
    expect(rcon.status).toHaveBeenCalledTimes(1);
  });

  it('sends nothing until status is asked for', () => {
    const rcon = createFakeRcon();
    shareStatusPerRound(new Map([['default', asRconClient(rcon)]]));
    expect(rcon.status).not.toHaveBeenCalled();
  });

  it('passes other commands to the real client', async () => {
    const rcon = createFakeRcon();
    const client = shareStatusPerRound(
      new Map([['default', asRconClient(rcon)]]),
    ).get('default')!;

    await client.kick(3, 'Banned');

    expect(rcon.kick).toHaveBeenCalledWith(3, 'Banned');
  });

  it('keeps servers apart', async () => {
    const one = createFakeRcon();
    const two = createFakeRcon();
    const shared = shareStatusPerRound(
      new Map([
        ['one', asRconClient(one)],
        ['two', asRconClient(two)],
      ]),
    );

    await shared.get('one')!.status();
    await shared.get('two')!.status();

    expect(one.status).toHaveBeenCalledTimes(1);
    expect(two.status).toHaveBeenCalledTimes(1);
  });
});

describe('runSweepRound', () => {
  it('sends one status per server for the ban, known and VPN sweeps together', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    rcon.status.mockResolvedValue(STATUS);
    banStore.listActiveIpBans.mockResolvedValue([
      { ip: '203.0.113.7' } as BanIp,
    ]);
    const knownSweep = vi
      .spyOn(deps.knownPlayers, 'sweep')
      .mockImplementation(async (d) => {
        await d.rconClients.get('default')!.status();
      });
    const vpnSweep = vi
      .spyOn(deps.vpnKick, 'sweep')
      .mockImplementation(async (d) => {
        await d.rconClients.get('default')!.status();
      });

    await runSweepRound(deps);

    expect(knownSweep).toHaveBeenCalledTimes(1);
    expect(vpnSweep).toHaveBeenCalledTimes(1);
    expect(rcon.status).toHaveBeenCalledTimes(1);
    expect(rcon.kick).toHaveBeenCalledWith(3, 'Banned');
  });

  it('asks again on the next round', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    banStore.listActiveIpBans.mockResolvedValue([
      { ip: '203.0.113.7' } as BanIp,
    ]);

    await runSweepRound(deps);
    await runSweepRound(deps);

    expect(rcon.status).toHaveBeenCalledTimes(2);
  });

  it('does not log a ban sweep timeout from a map load', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    banStore.listActiveIpBans.mockResolvedValue([
      { ip: '203.0.113.7' } as BanIp,
    ]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    rcon.status.mockResolvedValueOnce({ ...STATUS, mapName: 'mp_toujane' });
    await runSweepRound(deps);

    rcon.status.mockRejectedValueOnce(new UdpQueryTimeoutError('timed out'));
    await runSweepRound(deps);
    rcon.status.mockResolvedValueOnce({ ...STATUS, mapName: 'mp_decoy' });
    await runSweepRound(deps);

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('logs a ban sweep timeout when the map did not change', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    banStore.listActiveIpBans.mockResolvedValue([
      { ip: '203.0.113.7' } as BanIp,
    ]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    rcon.status.mockResolvedValueOnce({ ...STATUS, mapName: 'mp_toujane' });
    await runSweepRound(deps);

    rcon.status.mockRejectedValueOnce(new UdpQueryTimeoutError('timed out'));
    await runSweepRound(deps);
    expect(error).not.toHaveBeenCalled();
    rcon.status.mockResolvedValueOnce({ ...STATUS, mapName: 'mp_toujane' });
    await runSweepRound(deps);

    expect(error).toHaveBeenCalledWith(
      'Ban sweep failed for server "default":',
      expect.any(UdpQueryTimeoutError),
    );
    error.mockRestore();
  });
});
