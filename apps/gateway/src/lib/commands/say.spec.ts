import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { sayCommand } from './say.js';

describe('sayCommand', () => {
  it('broadcasts the message and audit-logs it', async () => {
    const { deps, rcon, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'hello everyone', admin: { telegramId: 1, role: 'admin' } });

    await sayCommand(ctx, deps);

    expect(rcon.say).toHaveBeenCalledWith('hello everyone');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'say', target: 'hello everyone' }));
    expect(ctx.reply).toHaveBeenCalledWith('Sent.');
  });

  it('prompts for usage when no message is given', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'admin' } });

    await sayCommand(ctx, deps);

    expect(rcon.say).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /say <message> [--server <alias>]');
  });
});
