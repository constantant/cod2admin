import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { removeServerCommand } from './removeserver.js';

const OWNER = { telegramId: 1, role: 'owner' as const };

describe('removeServerCommand', () => {
  it('removes an added server from the store and from the live client map', async () => {
    const { deps, adminStore } = createFakeDeps();
    deps.rconClients.set('ctf2', asRconClient(createFakeRcon()));
    const ctx = createFakeCtx({ match: 'ctf2', admin: OWNER });

    await removeServerCommand(ctx, deps);

    expect(adminStore.removeServer).toHaveBeenCalledWith('ctf2');
    expect(deps.rconClients.has('ctf2')).toBe(false);
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'removeserver', target: 'ctf2' }));
    expect(ctx.reply).toHaveBeenCalledWith('Server "ctf2" removed.');
  });

  it('refuses to remove the config-file server', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'default', admin: OWNER });

    await removeServerCommand(ctx, deps);

    expect(adminStore.removeServer).not.toHaveBeenCalled();
    expect(deps.rconClients.has('default')).toBe(true);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('comes from the bot\'s config file'));
  });

  it('rejects an unknown alias and shows usage when none is given', async () => {
    const { deps, adminStore } = createFakeDeps();
    const unknown = createFakeCtx({ match: 'nope', admin: OWNER });
    const empty = createFakeCtx({ match: '', admin: OWNER });

    await removeServerCommand(unknown, deps);
    await removeServerCommand(empty, deps);

    expect(adminStore.removeServer).not.toHaveBeenCalled();
    expect(unknown.reply).toHaveBeenCalledWith(expect.stringContaining('Unknown server "nope"'));
    expect(empty.reply).toHaveBeenCalledWith('Usage: /removeserver <alias>');
  });
});
