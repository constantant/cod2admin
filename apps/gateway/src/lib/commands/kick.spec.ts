import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { kickCommand } from './kick.js';

describe('kickCommand', () => {
  it('resolves a numeric client id to a name before kicking (this server only accepts names)', async () => {
    const { deps, rcon, adminStore } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [{ num: 3, score: 0, ping: 0, name: 'PlayerThree' }] });
    const ctx = createFakeCtx({ match: '3', admin: { telegramId: 1, role: 'admin' } });

    await kickCommand(ctx, deps);

    expect(rcon.kick).toHaveBeenCalledWith('PlayerThree');
    expect(rcon.say).toHaveBeenCalledWith('PlayerThree was kicked by an admin');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'kick', target: 'PlayerThree', serverAlias: 'default' }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('Kicked PlayerThree.');
  });

  it('passes a non-numeric target straight through as an already-a-name value', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'PlayerThree', admin: { telegramId: 1, role: 'admin' } });

    await kickCommand(ctx, deps);

    expect(rcon.status).not.toHaveBeenCalled();
    expect(rcon.kick).toHaveBeenCalledWith('PlayerThree');
  });

  it('refuses when the numeric client id is not currently connected', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [] });
    const ctx = createFakeCtx({ match: '3', admin: { telegramId: 1, role: 'admin' } });

    await kickCommand(ctx, deps);

    expect(rcon.kick).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Client 3 is not currently connected.');
  });

  it('prompts for usage when no target is given', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'admin' } });

    await kickCommand(ctx, deps);

    expect(rcon.kick).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /kick <client id or name> [--server <alias>]');
  });
});
