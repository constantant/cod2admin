import type { ServerStatus } from '@cod2admin/rcon-client';
import { describe, expect, it, vi } from 'vitest';
import { runBanEnforcementSweep, runBanExpirySweep } from './poller.js';
import { asBanStore, asRconClient, createFakeBanStore, createFakeRcon } from './testing/fakes.js';
import type { Ban, BanIp } from './types.js';

function sampleBan(overrides: Partial<BanIp> = {}): BanIp {
  return {
    id: 1,
    serverAlias: 'default',
    ip: '1.2.3.4',
    reason: null,
    bannedBy: 1,
    bannedAt: new Date(),
    expiresAt: null,
    unbannedAt: null,
    ...overrides,
  };
}

function sampleGuidBan(overrides: Partial<Ban> = {}): Ban {
  return {
    id: 1,
    serverAlias: 'default',
    guid: 'realguid',
    name: 'PlayerOne',
    reason: null,
    bannedBy: 1,
    bannedAt: new Date(),
    expiresAt: null,
    unbannedAt: null,
    ...overrides,
  };
}

function rconWithPlayers(players: ServerStatus['players']) {
  const rcon = createFakeRcon();
  rcon.status.mockResolvedValue({ raw: '', players });
  return rcon;
}

describe('runBanEnforcementSweep', () => {
  it('kicks a connected player whose IP matches an active ban_ips row', async () => {
    const banStoreFake = createFakeBanStore({ active: [sampleBan({ ip: '1.2.3.4' })] });
    const rconFake = rconWithPlayers([{ num: 3, score: 0, ping: 0, name: 'Cheater', ip: '1.2.3.4' }]);

    await runBanEnforcementSweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(rconFake.kick).toHaveBeenCalledWith('Cheater');
  });

  it('does not kick a connected player whose IP is not banned', async () => {
    const banStoreFake = createFakeBanStore({ active: [sampleBan({ ip: '1.2.3.4' })] });
    const rconFake = rconWithPlayers([{ num: 3, score: 0, ping: 0, name: 'Innocent', ip: '9.9.9.9' }]);

    await runBanEnforcementSweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(rconFake.kick).not.toHaveBeenCalled();
  });

  it('enforces a ban on every server, not just the one it was issued on', async () => {
    const banStoreFake = createFakeBanStore({
      active: [sampleBan({ serverAlias: 'server-a', ip: '1.2.3.4' })],
      activeBans: [sampleGuidBan({ serverAlias: 'server-a', guid: 'guid-x' })],
    });
    const rconA = rconWithPlayers([]);
    const rconB = rconWithPlayers([
      { num: 1, score: 0, ping: 0, name: 'ByIp', ip: '1.2.3.4', guid: '0' },
      { num: 2, score: 0, ping: 0, name: 'ByGuid', ip: '5.5.5.5', guid: 'guid-x' },
      { num: 3, score: 0, ping: 0, name: 'Innocent', ip: '9.9.9.9', guid: 'guid-y' },
    ]);

    await runBanEnforcementSweep(
      asBanStore(banStoreFake),
      new Map([
        ['server-a', asRconClient(rconA)],
        ['server-b', asRconClient(rconB)],
      ]),
    );

    expect(rconB.kick.mock.calls).toEqual([['ByIp'], ['ByGuid']]);
  });

  it('never matches GUID 0, which many unrelated players share', async () => {
    const banStoreFake = createFakeBanStore({ activeBans: [sampleGuidBan({ guid: '0' })] });
    const rconFake = rconWithPlayers([{ num: 1, score: 0, ping: 0, name: 'Someone', guid: '0' }]);

    await runBanEnforcementSweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(rconFake.status).not.toHaveBeenCalled();
    expect(rconFake.kick).not.toHaveBeenCalled();
  });

  it('skips the status() call entirely when there are no active bans', async () => {
    const banStoreFake = createFakeBanStore({ active: [], activeBans: [] });
    const rconFake = createFakeRcon();

    await runBanEnforcementSweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(rconFake.status).not.toHaveBeenCalled();
  });

  it('keeps sweeping the other servers when one fails, and reports the failure', async () => {
    const banStoreFake = createFakeBanStore({ active: [sampleBan({ ip: '1.2.3.4' })] });
    const failing = createFakeRcon();
    const failure = new Error('timed out');
    failing.status.mockRejectedValue(failure);
    const healthy = rconWithPlayers([{ num: 1, score: 0, ping: 0, name: 'Cheater', ip: '1.2.3.4' }]);
    const onError = vi.fn();

    await runBanEnforcementSweep(
      asBanStore(banStoreFake),
      new Map([
        ['down', asRconClient(failing)],
        ['up', asRconClient(healthy)],
      ]),
      onError,
    );

    expect(onError).toHaveBeenCalledWith('down', failure);
    expect(healthy.kick).toHaveBeenCalledWith('Cheater');
  });

  it('expires rows whose expiry has passed, with no rcon call needed', async () => {
    const banStoreFake = createFakeBanStore({ active: [], expired: [sampleBan({ id: 42 })] });
    const rconFake = createFakeRcon();

    await runBanEnforcementSweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(banStoreFake.expireIpBan).toHaveBeenCalledWith(42);
    expect(rconFake.status).not.toHaveBeenCalled();
  });
});

describe('runBanExpirySweep', () => {
  it('expires (store) a GUID-path temp ban whose expiry has passed, with no rcon call (temp bans are never in ban.txt)', async () => {
    const banStoreFake = createFakeBanStore({
      expiredBans: [sampleGuidBan({ id: 7, guid: 'realguid' }), sampleGuidBan({ id: 8, guid: null })],
    });

    await runBanExpirySweep(asBanStore(banStoreFake));

    expect(banStoreFake.expireBan).toHaveBeenCalledWith(7);
    expect(banStoreFake.expireBan).toHaveBeenCalledWith(8);
  });

  it('does nothing when there are no expired GUID bans', async () => {
    const banStoreFake = createFakeBanStore({ expiredBans: [] });

    await runBanExpirySweep(asBanStore(banStoreFake));

    expect(banStoreFake.expireBan).not.toHaveBeenCalled();
  });
});
