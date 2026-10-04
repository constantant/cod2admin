import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { setDefaultCommand } from './setdefault.js';

const ADMIN = { telegramId: 1, role: 'admin' as const };

describe('setDefaultCommand', () => {
  it('makes a known server the default and audits it', async () => {
    const { deps, adminStore } = createFakeDeps();
    deps.rconClients.set('ctf2', asRconClient(createFakeRcon()));
    const ctx = createFakeCtx({ match: 'ctf2', admin: ADMIN });

    await setDefaultCommand(ctx, deps);

    expect(adminStore.setDefaultServer).toHaveBeenCalledWith('ctf2');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'setdefault', target: 'ctf2' }));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('now go to "ctf2"'));
  });

  it('rejects an unknown alias and shows usage when none is given', async () => {
    const { deps, adminStore } = createFakeDeps();
    const unknown = createFakeCtx({ match: 'nope', admin: ADMIN });
    const empty = createFakeCtx({ match: '', admin: ADMIN });

    await setDefaultCommand(unknown, deps);
    await setDefaultCommand(empty, deps);

    expect(adminStore.setDefaultServer).not.toHaveBeenCalled();
    expect(unknown.reply).toHaveBeenCalledWith(expect.stringContaining('Unknown server "nope"'));
    expect(empty.reply).toHaveBeenCalledWith('Usage: /setdefault <alias>');
  });
});
