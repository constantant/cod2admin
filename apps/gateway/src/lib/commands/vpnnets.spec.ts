import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { VPN_NETWORKS_SETTING_KEY, VpnRangeDatabase } from '../vpn-ranges.js';
import { vpnNetsCommand } from './vpnnets.js';

const ADMIN = { telegramId: 7, role: 'admin' as const };
const VPN_IP = '2.27.5.10';

function setup(stored?: unknown) {
  const fake = createFakeDeps();
  fake.adminStore.getSetting.mockResolvedValue(stored);
  fake.deps.provider = {
    lookup: (ip) => (ip === VPN_IP ? 'Emil Vitukhnovskii trading as Great Flower' : undefined),
    asn: (ip) => (ip === VPN_IP ? 202226 : undefined),
  };
  const vpn = new VpnRangeDatabase((ip) => fake.deps.provider.asn(ip));
  fake.deps.vpn = vpn;
  return { ...fake, vpn };
}

function ctx(match: string) {
  return createFakeCtx({ match, admin: ADMIN });
}

function replyText(c: ReturnType<typeof ctx>): string {
  return vi.mocked(c.reply).mock.calls[0][0] as string;
}

describe('vpnNetsCommand', () => {
  it('lists the saved networks with their provider names', async () => {
    const { deps } = setup([{ asn: 202226, name: 'Great Flower' }, { asn: 9009 }]);
    const c = ctx('');

    await vpnNetsCommand(c, deps);

    expect(replyText(c)).toContain('• AS202226 — Great Flower');
    expect(replyText(c)).toContain('• AS9009');
  });

  it('says when there are none', async () => {
    const { deps } = setup();
    const c = ctx('');

    await vpnNetsCommand(c, deps);

    expect(replyText(c)).toContain('No provider networks are marked as VPN.');
  });

  it("adds a player's network by IP, saves it with the provider name and flags it right away", async () => {
    const { deps, adminStore, vpn } = setup();
    const c = ctx(`add ${VPN_IP}`);
    expect(vpn.lookup(VPN_IP)).toBeUndefined();

    await vpnNetsCommand(c, deps);

    expect(adminStore.setSetting).toHaveBeenCalledWith(VPN_NETWORKS_SETTING_KEY, [
      { asn: 202226, name: 'Emil Vitukhnovskii trading as Great Flower' },
    ]);
    expect(vpn.lookup(VPN_IP)).toBe('provider');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'vpnnets', actorTelegramId: 7, detailJson: { add: 202226 } }),
    );
    expect(replyText(c)).toBe('Players on AS202226 — Emil Vitukhnovskii trading as Great Flower are now shown as 🛡 VPN.');
  });

  it.each(['AS202226', 'as202226', '202226'])('adds a network by ASN written as %s', async (arg) => {
    const { deps, adminStore } = setup([{ asn: 9009 }]);

    await vpnNetsCommand(ctx(`add ${arg}`), deps);

    expect(adminStore.setSetting).toHaveBeenCalledWith(VPN_NETWORKS_SETTING_KEY, [{ asn: 9009 }, { asn: 202226 }]);
  });

  it('refuses duplicates, unknown IPs and junk without saving', async () => {
    for (const [match, expected] of [
      ['add AS202226', 'AS202226 is already marked as VPN.'],
      ['add 8.8.8.8', "Couldn't find the provider network for 8.8.8.8"],
      ['add hello', 'Usage: /vpnnets add'],
      ['add', 'Usage: /vpnnets add'],
      ['remove AS1', 'Usage: /vpnnets remove'],
    ]) {
      const { deps, adminStore } = setup([{ asn: 202226 }]);
      const c = ctx(match);

      await vpnNetsCommand(c, deps);

      expect(adminStore.setSetting).not.toHaveBeenCalled();
      expect(replyText(c)).toContain(expected);
    }
  });

  it('removes a network and stops flagging it', async () => {
    const { deps, adminStore, vpn } = setup([{ asn: 202226, name: 'Great Flower' }, { asn: 9009 }]);
    vpn.setNetworks([202226, 9009]);
    const c = ctx('remove AS202226');

    await vpnNetsCommand(c, deps);

    expect(adminStore.setSetting).toHaveBeenCalledWith(VPN_NETWORKS_SETTING_KEY, [{ asn: 9009 }]);
    expect(vpn.lookup(VPN_IP)).toBeUndefined();
    expect(replyText(c)).toBe('AS202226 is no longer marked as VPN.');
  });

  it('warns when VPN flags are turned off on this bot', async () => {
    const fake = createFakeDeps();
    fake.adminStore.getSetting.mockResolvedValue(undefined);
    const c = ctx('');

    await vpnNetsCommand(c, fake.deps);

    expect(replyText(c)).toContain('VPN_FLAG_ENABLED=false');
  });
});
