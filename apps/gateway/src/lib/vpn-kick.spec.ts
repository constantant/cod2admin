import type { StatusPlayer } from '@cod2admin/rcon-client';
import { describe, expect, it, vi } from 'vitest';
import { createFakeAdminStore } from './testing/fake-admin-store.js';
import { asRconClient, createFakeRcon } from './testing/fake-rcon.js';
import { normalizeExempt, parseVpnKickSettings, VpnKicker } from './vpn-kick.js';
import type { VpnKind } from './vpn-ranges.js';

const VPN_IP = '185.93.105.43';
const PLAYERS: StatusPlayer[] = [
  { num: 0, score: 1, ping: 50, name: 'const^7', ip: VPN_IP, guid: '0' },
  { num: 1, score: 9, ping: 60, name: 'Regular', ip: '188.19.61.1', guid: '716922' },
];

function setup(kinds: Record<string, VpnKind> = { [VPN_IP]: 'hosting' }) {
  const rcon = createFakeRcon();
  rcon.status.mockResolvedValue({ raw: '', players: PLAYERS });
  const adminStore = createFakeAdminStore();
  let now = 1_000_000;
  const kicker = new VpnKicker(() => now);
  const deps = {
    vpn: { lookup: (ip: string) => kinds[ip] },
    rconClients: new Map([['ctfrussia', asRconClient(rcon)]]),
    adminStore,
  };
  return { rcon, adminStore, kicker, deps, advance: (ms: number) => (now += ms) };
}

describe('VpnKicker', () => {
  it('does nothing — not even a status query — while off', async () => {
    const { rcon, kicker, deps } = setup();

    await kicker.sweep(deps);

    expect(rcon.status).not.toHaveBeenCalled();
  });

  it('kicks only flagged players, announcing it in game chat and the audit log', async () => {
    const { rcon, adminStore, kicker, deps } = setup();
    kicker.setSettings({ enabled: true, exempt: [] });

    await kicker.sweep(deps);

    expect(rcon.kick).toHaveBeenCalledTimes(1);
    expect(rcon.kick).toHaveBeenCalledWith('const^7');
    expect(rcon.say).toHaveBeenCalledWith('const kicked: VPN/proxy is not allowed here. Turn it off to play.');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'vpn_kick',
        target: 'const',
        serverAlias: 'ctfrussia',
        source: 'auto',
        detailJson: { ip: VPN_IP, guid: '0', kind: 'hosting' },
      }),
    );
  });

  it('kicks a rejoining player every sweep but announces only once per 5 minutes', async () => {
    const { rcon, adminStore, kicker, deps, advance } = setup();
    kicker.setSettings({ enabled: true, exempt: [] });

    await kicker.sweep(deps);
    advance(10_000);
    await kicker.sweep(deps);
    expect(rcon.kick).toHaveBeenCalledTimes(2);
    expect(rcon.say).toHaveBeenCalledTimes(1);
    expect(adminStore.recordAuditLog).toHaveBeenCalledTimes(1);

    advance(5 * 60 * 1000);
    await kicker.sweep(deps);
    expect(rcon.say).toHaveBeenCalledTimes(2);
  });

  it('never kicks exempt players, by GUID or by colour-stripped name', async () => {
    const { rcon, kicker, deps } = setup({ [VPN_IP]: 'vpn', '188.19.61.1': 'hosting' });
    kicker.setSettings({ enabled: true, exempt: ['716922', 'const'] });

    await kicker.sweep(deps);

    expect(rcon.kick).not.toHaveBeenCalled();
  });

  it('keeps sweeping other servers when one fails', async () => {
    const { rcon, kicker, deps } = setup();
    const broken = createFakeRcon();
    broken.status.mockRejectedValue(new Error('timeout'));
    deps.rconClients = new Map([
      ['broken', asRconClient(broken)],
      ['ctfrussia', asRconClient(rcon)],
    ]);
    kicker.setSettings({ enabled: true, exempt: [] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await kicker.sweep(deps);

    expect(rcon.kick).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"broken"'), expect.any(Error));
    error.mockRestore();
  });
});

describe('settings helpers', () => {
  it('parses stored settings defensively', () => {
    expect(parseVpnKickSettings({ enabled: true, exempt: ['716922', 3, ''] })).toEqual({ enabled: true, exempt: ['716922'] });
    expect(parseVpnKickSettings({ enabled: 'yes' })).toEqual({ enabled: false, exempt: [] });
    expect(parseVpnKickSettings(undefined)).toEqual({ enabled: false, exempt: [] });
  });

  it('stores a GUID as-is and a name lower-cased without colour codes', () => {
    expect(normalizeExempt(' 716922 ')).toBe('716922');
    expect(normalizeExempt('^^11Const^7')).toBe('const');
  });
});
