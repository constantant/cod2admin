import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { rconCommand } from './rcon.js';

describe('rconCommand', () => {
  it('sends the raw command verbatim, replies with the output, and audit-logs it', async () => {
    const { deps, rcon, adminStore } = createFakeDeps();
    rcon.rcon.mockResolvedValue('Kicked player 3');
    const ctx = createFakeCtx({ match: 'kick 3', admin: { telegramId: 1, role: 'owner' } });

    await rconCommand(ctx, deps);

    expect(rcon.rcon).toHaveBeenCalledWith('kick 3');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rcon', target: 'kick 3', detailJson: { command: 'kick 3' } }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('Kicked player 3');
  });

  it('replies with a placeholder when the command has no output', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.rcon.mockResolvedValue('');
    const ctx = createFakeCtx({ match: 'noop', admin: { telegramId: 1, role: 'owner' } });

    await rconCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith('(no output)');
  });

  it('prompts for usage when no command is given', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'owner' } });

    await rconCommand(ctx, deps);

    expect(rcon.rcon).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /rcon <raw command> [--server <alias>]');
  });
});
