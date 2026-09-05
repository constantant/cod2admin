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
