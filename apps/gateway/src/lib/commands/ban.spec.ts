import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { banCommand } from './ban.js';

describe('banCommand', () => {
  it('bans by client id, records the ban, and broadcasts without a reason', async () => {
    const { deps, rcon, banStore, adminStore } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [{ num: 2, score: 0, ping: 0, name: 'Cheater', ip: '1.2.3.4' }] });
    const ctx = createFakeCtx({ match: '2', admin: { telegramId: 1, role: 'admin' } });

    await banCommand(ctx, deps);

    expect(rcon.banUser).toHaveBeenCalledWith(2);
    expect(banStore.recordBan).toHaveBeenCalledWith(
      expect.objectContaining({ serverAlias: 'default', name: 'Cheater', reason: null }),
    );
    expect(rcon.say).toHaveBeenCalledWith('client 2 was banned by an admin');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ban', target: 'Cheater' }));
    expect(ctx.reply).toHaveBeenCalledWith('Banned client 2. IP: 1.2.3.4 (note this in case the ban doesn\'t stick — common on this server.)');
  });

  it('includes a sanitized reason in the broadcast and reply', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [] });
    const ctx = createFakeCtx({ match: '2 cheating; banUser 0', admin: { telegramId: 1, role: 'admin' } });

    await banCommand(ctx, deps);

    expect(rcon.banUser).toHaveBeenCalledWith(2);
    expect(rcon.say).toHaveBeenCalledWith('client 2 (cheating banUser 0) was banned by an admin');
    expect(ctx.reply).toHaveBeenCalledWith('Banned client 2 for: cheating banUser 0.');
  });

  it('prompts for usage when the client id is missing or not a number', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'not-a-number', admin: { telegramId: 1, role: 'admin' } });

    await banCommand(ctx, deps);

    expect(rcon.banUser).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /ban <client id> [reason] [--server <alias>]');
  });
});
