import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { mapCommand } from './map.js';

describe('mapCommand', () => {
  it('changes the map and audit-logs it', async () => {
    const { deps, rcon, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'mp_toujane', admin: { telegramId: 1, role: 'admin' } });

    await mapCommand(ctx, deps);

    expect(rcon.map).toHaveBeenCalledWith('mp_toujane');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'map', target: 'mp_toujane' }));
    expect(ctx.reply).toHaveBeenCalledWith('Changing map to mp_toujane...');
  });

  it('prompts for usage when no map name is given', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'admin' } });

    await mapCommand(ctx, deps);

    expect(rcon.map).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /map <name> [--server <alias>]');
  });
});

describe('mapCommand with the installed map list', () => {
  const ADMIN = { telegramId: 1, role: 'admin' as const };

  it('uses the installed name for a case-insensitive match', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getInstalledMaps.mockResolvedValue(['mp_toujane', 'rts']);
    const ctx = createFakeCtx({ match: 'MP_Toujane', admin: ADMIN });

    await mapCommand(ctx, deps);

    expect(rcon.map).toHaveBeenCalledWith('mp_toujane');
    expect(ctx.reply).toHaveBeenCalledWith('Changing map to mp_toujane...');
  });

  it('refuses an unknown map with suggestions instead of sending it', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getInstalledMaps.mockResolvedValue(['mp_toujane', 'mp_trainstation', 'rts']);
    const ctx = createFakeCtx({ match: 'mp_train', admin: ADMIN });

    await mapCommand(ctx, deps);

    expect(rcon.map).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      'There\'s no map "mp_train" on default. Did you mean: mp_trainstation? /maps lists every installed map.',
    );
  });

  it('warns after switching to a custom map', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getInstalledMaps.mockResolvedValue(['mp_toujane', 'rts']);
    const ctx = createFakeCtx({ match: 'rts', admin: ADMIN });

    await mapCommand(ctx, deps);

    expect(rcon.map).toHaveBeenCalledWith('rts');
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Changing map to rts... Note: it's not a standard CoD2 map"));
  });
});
