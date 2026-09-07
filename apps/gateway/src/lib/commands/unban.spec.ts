import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { unbanCommand } from './unban.js';

describe('unbanCommand', () => {
  it('unbans the given GUID via rcon, clears it from the store, and audit-logs it', async () => {
    const { deps, rcon, banStore, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'GUID123', admin: { telegramId: 1, role: 'admin' } });

    await unbanCommand(ctx, deps);

    expect(rcon.unbanUser).toHaveBeenCalledWith('GUID123');
    expect(banStore.unbanByGuid).toHaveBeenCalledWith('default', 'GUID123');
    expect(banStore.unbanIp).not.toHaveBeenCalled();
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'unban', target: 'GUID123' }));
    expect(ctx.reply).toHaveBeenCalledWith('Unbanned GUID GUID123.');
  });

  it('unbans the given IP in the store, without any rcon call', async () => {
    const { deps, rcon, banStore, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '1.2.3.4', admin: { telegramId: 1, role: 'admin' } });

    await unbanCommand(ctx, deps);

    expect(rcon.unbanUser).not.toHaveBeenCalled();
    expect(banStore.unbanIp).toHaveBeenCalledWith('default', '1.2.3.4');
    expect(banStore.unbanByGuid).not.toHaveBeenCalled();
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'unban', target: '1.2.3.4' }));
    expect(ctx.reply).toHaveBeenCalledWith('Unbanned IP 1.2.3.4.');
  });

  it('prompts for usage when no target is given', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'admin' } });

    await unbanCommand(ctx, deps);

    expect(rcon.unbanUser).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /unban <guid-or-ip> [--server <alias>]');
  });
});
