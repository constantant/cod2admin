import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { unbanCommand } from './unban.js';

describe('unbanCommand', () => {
  it('unbans the given GUID and audit-logs it', async () => {
    const { deps, rcon, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'GUID123', admin: { telegramId: 1, role: 'admin' } });

    await unbanCommand(ctx, deps);

    expect(rcon.unbanUser).toHaveBeenCalledWith('GUID123');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'unban', target: 'GUID123' }));
    expect(ctx.reply).toHaveBeenCalledWith('Unbanned GUID GUID123.');
  });

  it('prompts for usage when no GUID is given', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'admin' } });

    await unbanCommand(ctx, deps);

    expect(rcon.unbanUser).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /unban <guid> [--server <alias>]');
  });
});
