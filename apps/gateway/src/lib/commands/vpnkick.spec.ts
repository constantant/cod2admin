import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { VPN_KICK_SETTING_KEY } from '../vpn-kick.js';
import { VpnRangeDatabase } from '../vpn-ranges.js';
import { vpnKickCommand } from './vpnkick.js';

const ADMIN = { telegramId: 7, role: 'admin' as const };

function setup() {
  const fake = createFakeDeps();
  fake.deps.vpn = new VpnRangeDatabase();
  return fake;
}

function ctx(match: string) {
  return createFakeCtx({ match, admin: ADMIN });
}

function replyText(c: ReturnType<typeof ctx>): string {
  return vi.mocked(c.reply).mock.calls[0]![0] as string;
}

describe('vpnKickCommand', () => {
  it('shows that it is off by default', async () => {
    const { deps } = setup();
    const c = ctx('');

    await vpnKickCommand(c, deps);

    expect(replyText(c)).toContain('VPN kick is OFF');
    expect(replyText(c)).toContain('Nobody is exempt.');
  });

  it('turns it on and off, saving, applying at once and auditing', async () => {
    const { deps, adminStore } = setup();

    await vpnKickCommand(ctx('on'), deps);
    expect(deps.vpnKick.settings.enabled).toBe(true);
    expect(adminStore.setSetting).toHaveBeenLastCalledWith(VPN_KICK_SETTING_KEY, { enabled: true, exempt: [] });
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'vpnkick', actorTelegramId: 7, detailJson: { enabled: true } }),
    );

    const off = ctx('OFF');
    await vpnKickCommand(off, deps);
    expect(deps.vpnKick.settings.enabled).toBe(false);
    expect(replyText(off)).toContain('VPN kick is OFF');
  });

  it('exempts players by GUID or name and lists them', async () => {
    const { deps, adminStore } = setup();

    const byName = ctx('allow ^1Const^7');
    await vpnKickCommand(byName, deps);
    expect(replyText(byName)).toContain('const will never be kicked');
    expect(replyText(byName)).toContain('a GUID is safer');

    await vpnKickCommand(ctx('allow 716922'), deps);
    expect(deps.vpnKick.settings.exempt).toEqual(['const', '716922']);
    expect(adminStore.setSetting).toHaveBeenLastCalledWith(VPN_KICK_SETTING_KEY, { enabled: false, exempt: ['const', '716922'] });

    const list = ctx('');
    await vpnKickCommand(list, deps);
    expect(replyText(list)).toContain('Never kicked: const, 716922');

    await vpnKickCommand(ctx('unallow CONST'), deps);
    expect(deps.vpnKick.settings.exempt).toEqual(['716922']);
  });

  it('refuses duplicates, unknown entries and a missing argument', async () => {
    const { deps, adminStore } = setup();
    deps.vpnKick.setSettings({ enabled: true, exempt: ['716922'] });

    for (const [match, expected] of [
      ['allow 716922', 'already exempt'],
      ['unallow nobody', "isn't exempt"],
      ['allow', 'Usage: /vpnkick allow'],
    ]) {
      const c = ctx(match);
      await vpnKickCommand(c, deps);
      expect(replyText(c)).toContain(expected);
    }
    expect(adminStore.setSetting).not.toHaveBeenCalled();
  });

  it('warns when VPN flags are off on this bot', async () => {
    const fake = createFakeDeps();
    const c = ctx('on');

    await vpnKickCommand(c, fake.deps);

    expect(replyText(c)).toContain('VPN_FLAG_ENABLED=false');
  });
});
