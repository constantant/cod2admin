import { describe, expect, it, vi } from 'vitest';
import { DIRECT_TELEGRAM_ROOT, ROUTES_SETTING_KEY } from '../telegram-routes.js';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { relaysCommand } from './relays.js';

const OWNER = { telegramId: 1, role: 'owner' as const };
const RELAY = 'https://a.deno.dev';

function setup(stored?: unknown) {
  const fake = createFakeDeps();
  fake.deps.telegramRoutes.defaults = { direct: true, relays: [RELAY] };
  fake.deps.telegramRoutes.router.setRoutes([DIRECT_TELEGRAM_ROOT, RELAY]);
  fake.adminStore.getSetting.mockResolvedValue(stored);
  return fake;
}

function ctx(match: string) {
  return createFakeCtx({ match, admin: OWNER });
}

describe('relaysCommand', () => {
  it('shows the routes in order, which one is in use, and that these are the defaults', async () => {
    const { deps } = setup();
    const c = ctx('');

    await relaysCommand(c, deps);

    const text = vi.mocked(c.reply).mock.calls[0][0];
    expect(text).toContain('Connected to Telegram via: direct (api.telegram.org)');
    expect(text).toContain('1. direct (api.telegram.org)  ← in use');
    expect(text).toContain(`2. ${RELAY}`);
    expect(text).toContain('These are the defaults.');
  });

  it('adds a relay only after reaching Telegram through it, saves it and uses it right away', async () => {
    const { deps, adminStore } = setup();
    const c = ctx('add https://new.workers.dev/');

    await relaysCommand(c, deps);

    expect(deps.telegramRoutes.probe).toHaveBeenCalledWith('https://new.workers.dev');
    expect(adminStore.setSetting).toHaveBeenCalledWith(ROUTES_SETTING_KEY, {
      direct: true,
      relays: [RELAY, 'https://new.workers.dev'],
    });
    expect(deps.telegramRoutes.router.all).toEqual([DIRECT_TELEGRAM_ROOT, RELAY, 'https://new.workers.dev']);
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'relays' }));
    expect(c.reply).toHaveBeenCalledWith(expect.stringContaining('Added https://new.workers.dev'));
  });

  it('refuses a relay that can\'t reach Telegram', async () => {
    const { deps, adminStore } = setup();
    deps.telegramRoutes.probe = async () => ({ ok: false, error: 'no answer within 10s' });
    const c = ctx('add https://broken.example');

    await relaysCommand(c, deps);

    expect(adminStore.setSetting).not.toHaveBeenCalled();
    expect(c.reply).toHaveBeenCalledWith(expect.stringContaining("Couldn't reach Telegram through https://broken.example"));
  });

  it('removes a relay by its number in the list', async () => {
    const { deps, adminStore } = setup({ direct: true, relays: [RELAY, 'https://b.workers.dev'] });
    const c = ctx('remove 2');

    await relaysCommand(c, deps);

    expect(adminStore.setSetting).toHaveBeenCalledWith(ROUTES_SETTING_KEY, { direct: true, relays: ['https://b.workers.dev'] });
  });

  it('never leaves the bot without a route', async () => {
    const { deps, adminStore } = setup({ direct: false, relays: [RELAY] });

    const remove = ctx(`remove ${RELAY}`);
    await relaysCommand(remove, deps);
    expect(remove.reply).toHaveBeenCalledWith(expect.stringContaining('only route left'));

    const noRelays = setup({ direct: true, relays: [] });
    noRelays.adminStore.getSetting.mockResolvedValue({ direct: true, relays: [] });
    const directOff = ctx('direct off');
    await relaysCommand(directOff, noRelays.deps);
    expect(adminStore.setSetting).not.toHaveBeenCalled();
  });

  it('turns direct access off', async () => {
    const { deps, adminStore } = setup();

    await relaysCommand(ctx('direct off'), deps);

    expect(adminStore.setSetting).toHaveBeenCalledWith(ROUTES_SETTING_KEY, { direct: false, relays: [RELAY] });
    expect(deps.telegramRoutes.router.all).toEqual([RELAY]);
  });

  it('resets to the defaults', async () => {
    const { deps, adminStore } = setup({ direct: false, relays: ['https://b.workers.dev'] });
    deps.telegramRoutes.router.setRoutes(['https://b.workers.dev']);

    await relaysCommand(ctx('reset'), deps);

    expect(adminStore.deleteSetting).toHaveBeenCalledWith(ROUTES_SETTING_KEY);
    expect(deps.telegramRoutes.router.all).toEqual([DIRECT_TELEGRAM_ROOT, RELAY]);
  });

  it('tests every route', async () => {
    const { deps } = setup();
    const c = ctx('test');

    await relaysCommand(c, deps);

    expect(c.reply).toHaveBeenCalledWith(
      ['Route check:', '1. direct (api.telegram.org) — ✅ 50 ms', `2. ${RELAY} — ✅ 50 ms`].join('\n'),
    );
  });
});
