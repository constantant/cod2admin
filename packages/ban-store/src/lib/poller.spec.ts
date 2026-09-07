import type { ServerStatus } from '@cod2admin/rcon-client';
import { describe, expect, it } from 'vitest';
import { runBanExpirySweep, runIpBanSweep } from './poller.js';
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

describe('runIpBanSweep', () => {
  it('kicks a connected player whose IP matches an active ban_ips row', async () => {
    const banStoreFake = createFakeBanStore({ active: [sampleBan({ ip: '1.2.3.4' })] });
    const rconFake = createFakeRcon();
    rconFake.status.mockResolvedValue({
      raw: '',
      players: [{ num: 3, score: 0, ping: 0, name: 'Cheater', ip: '1.2.3.4' }],
    } satisfies ServerStatus);

    await runIpBanSweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(rconFake.kick).toHaveBeenCalledWith('Cheater');
  });

  it('does not kick a connected player whose IP is not banned', async () => {
    const banStoreFake = createFakeBanStore({ active: [sampleBan({ ip: '1.2.3.4' })] });
    const rconFake = createFakeRcon();
    rconFake.status.mockResolvedValue({
      raw: '',
      players: [{ num: 3, score: 0, ping: 0, name: 'Innocent', ip: '9.9.9.9' }],
    } satisfies ServerStatus);

    await runIpBanSweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(rconFake.kick).not.toHaveBeenCalled();
  });

  it('skips the status() call entirely when there are no active bans', async () => {
    const banStoreFake = createFakeBanStore({ active: [] });
    const rconFake = createFakeRcon();

    await runIpBanSweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(rconFake.status).not.toHaveBeenCalled();
  });

  it('expires rows whose expiry has passed, with no rcon call needed', async () => {
    const banStoreFake = createFakeBanStore({ active: [], expired: [sampleBan({ id: 42 })] });
    const rconFake = createFakeRcon();

    await runIpBanSweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(banStoreFake.expireIpBan).toHaveBeenCalledWith(42);
  });

  it('sweeps every configured server independently', async () => {
    const banStoreFake = createFakeBanStore({ active: [sampleBan({ ip: '1.2.3.4' })] });
    const rconA = createFakeRcon();
    const rconB = createFakeRcon();
    rconA.status.mockResolvedValue({ raw: '', players: [{ num: 1, score: 0, ping: 0, name: 'A', ip: '1.2.3.4' }] });
    rconB.status.mockResolvedValue({ raw: '', players: [{ num: 2, score: 0, ping: 0, name: 'B', ip: '1.2.3.4' }] });

    await runIpBanSweep(
      asBanStore(banStoreFake),
      new Map([
        ['server-a', asRconClient(rconA)],
        ['server-b', asRconClient(rconB)],
      ]),
    );

    expect(rconA.kick).toHaveBeenCalledWith('A');
    expect(rconB.kick).toHaveBeenCalledWith('B');
  });
});

describe('runBanExpirySweep', () => {
  it('unbans (rcon) and expires (store) a GUID-path temp ban whose expiry has passed', async () => {
    const banStoreFake = createFakeBanStore({ expiredBans: [sampleGuidBan({ id: 7, guid: 'realguid' })] });
    const rconFake = createFakeRcon();

    await runBanExpirySweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(rconFake.unbanUser).toHaveBeenCalledWith('realguid');
    expect(banStoreFake.expireBan).toHaveBeenCalledWith(7);
  });

  it('skips the rcon unban call for a row with no guid, but still expires it', async () => {
    const banStoreFake = createFakeBanStore({ expiredBans: [sampleGuidBan({ id: 8, guid: null })] });
    const rconFake = createFakeRcon();

    await runBanExpirySweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(rconFake.unbanUser).not.toHaveBeenCalled();
    expect(banStoreFake.expireBan).toHaveBeenCalledWith(8);
  });

  it('does nothing when there are no expired GUID bans', async () => {
    const banStoreFake = createFakeBanStore({ expiredBans: [] });
    const rconFake = createFakeRcon();

    await runBanExpirySweep(asBanStore(banStoreFake), new Map([['default', asRconClient(rconFake)]]));

    expect(rconFake.unbanUser).not.toHaveBeenCalled();
    expect(banStoreFake.expireBan).not.toHaveBeenCalled();
  });

  it('sweeps every configured server independently', async () => {
    const banStoreFake = createFakeBanStore({ expiredBans: [sampleGuidBan({ id: 1, guid: 'guid-x' })] });
    const rconA = createFakeRcon();
    const rconB = createFakeRcon();

    await runBanExpirySweep(
      asBanStore(banStoreFake),
      new Map([
        ['server-a', asRconClient(rconA)],
        ['server-b', asRconClient(rconB)],
      ]),
    );

    expect(rconA.unbanUser).toHaveBeenCalledWith('guid-x');
    expect(rconB.unbanUser).toHaveBeenCalledWith('guid-x');
  });
});
