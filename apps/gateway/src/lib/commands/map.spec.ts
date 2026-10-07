import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { mapCommand } from './map.js';

describe('mapCommand', () => {
  it('changes the map and audit-logs it', async () => {
    const { deps, rcon, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({
      match: 'mp_toujane',
      admin: { telegramId: 1, role: 'admin' },
    });

    await mapCommand(ctx, deps);

    expect(rcon.map).toHaveBeenCalledWith('mp_toujane', undefined);
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'map', target: 'mp_toujane' }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('Changing map to mp_toujane...');
  });

  it('prompts for usage when no map name is given', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({
      match: '',
      admin: { telegramId: 1, role: 'admin' },
    });

    await mapCommand(ctx, deps);

    expect(rcon.map).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      'Usage: /map <name> [mode] [--server <alias>], e.g. /map mp_toujane ctf',
    );
  });
});

describe('mapCommand with the installed map list', () => {
  const ADMIN = { telegramId: 1, role: 'admin' as const };

  it('uses the installed name for a case-insensitive match', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getInstalledMaps.mockResolvedValue(['mp_toujane', 'rts']);
    const ctx = createFakeCtx({ match: 'MP_Toujane', admin: ADMIN });

    await mapCommand(ctx, deps);

    expect(rcon.map).toHaveBeenCalledWith('mp_toujane', undefined);
    expect(ctx.reply).toHaveBeenCalledWith('Changing map to mp_toujane...');
  });

  it('refuses an unknown map with suggestions instead of sending it', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getInstalledMaps.mockResolvedValue([
      'mp_toujane',
      'mp_trainstation',
      'rts',
    ]);
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

    expect(rcon.map).toHaveBeenCalledWith('rts', undefined);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining(
        "Changing map to rts... Note: it's not a standard CoD2 map",
      ),
    );
  });

  it("switches the mode too when one is given, using the server's spelling", async () => {
    const { deps, rcon, adminStore } = createFakeDeps();
    rcon.getInstalledMaps.mockResolvedValue(['mp_toujane']);
    rcon.getGametypes.mockResolvedValue(['ctf', 'dm', 'hq', 'sd', 'tdm']);
    const ctx = createFakeCtx({ match: 'mp_toujane CTF', admin: ADMIN });

    await mapCommand(ctx, deps);

    expect(rcon.map).toHaveBeenCalledWith('mp_toujane', 'ctf');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'map',
        target: 'mp_toujane (ctf)',
        detailJson: { map: 'mp_toujane', gametype: 'ctf' },
      }),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      'Changing map to mp_toujane (ctf)...',
    );
  });

  it('refuses a mode the server does not have, listing the ones it has', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getInstalledMaps.mockResolvedValue(['mp_toujane']);
    rcon.getGametypes.mockResolvedValue(['ctf', 'tdm']);
    const ctx = createFakeCtx({ match: 'mp_toujane zombies', admin: ADMIN });

    await mapCommand(ctx, deps);

    expect(rcon.map).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      `There's no game mode "zombies" on default. It has: ctf, tdm.`,
    );
  });
});
