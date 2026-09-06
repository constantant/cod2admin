import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { banCommand } from './ban.js';

describe('banCommand', () => {
  it('bans via the GUID path when status() reports one, and replies accordingly', async () => {
    const { deps, rcon, banStore, adminStore } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [{ num: 2, score: 0, ping: 0, name: 'Cheater', guid: 'realguid', ip: '1.2.3.4' }] });
    const ctx = createFakeCtx({ match: '2', admin: { telegramId: 1, role: 'admin' } });

    await banCommand(ctx, deps);

    expect(rcon.banUser).toHaveBeenCalledWith(2);
    expect(banStore.recordBan).toHaveBeenCalledWith(
      expect.objectContaining({ serverAlias: 'default', name: 'Cheater', guid: 'realguid', reason: null }),
    );
    expect(rcon.say).toHaveBeenCalledWith('Cheater was banned by an admin');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ban', target: 'Cheater' }));
    expect(ctx.reply).toHaveBeenCalledWith('Banned Cheater.');
  });

  it('falls back to an IP ban when the target has no GUID (docs/PLAN.md §2.4/§5 step 7)', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [{ num: 2, score: 0, ping: 0, name: 'Cheater', ip: '1.2.3.4' }] });
    const ctx = createFakeCtx({ match: '2', admin: { telegramId: 1, role: 'admin' } });

    await banCommand(ctx, deps);

    expect(rcon.banUser).not.toHaveBeenCalled();
    expect(rcon.kick).toHaveBeenCalledWith('Cheater');
    expect(banStore.recordIpBan).toHaveBeenCalledWith(expect.objectContaining({ ip: '1.2.3.4' }));
    expect(ctx.reply).toHaveBeenCalledWith('IP-banned (GUID unavailable) Cheater.');
  });

  it('includes a reason in the broadcast, audit log, and reply', async () => {
    const { deps, rcon, adminStore } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [{ num: 2, score: 0, ping: 0, name: 'Cheater', guid: 'realguid' }] });
    const ctx = createFakeCtx({ match: '2 cheating; banUser 0', admin: { telegramId: 1, role: 'admin' } });

    await banCommand(ctx, deps);

    expect(rcon.say).toHaveBeenCalledWith('Cheater was banned by an admin');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cheating banUser 0' }));
    expect(ctx.reply).toHaveBeenCalledWith('Banned Cheater for: cheating; banUser 0.');
  });

  it('refuses when the client id is not currently connected', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [] });
    const ctx = createFakeCtx({ match: '2', admin: { telegramId: 1, role: 'admin' } });

    await banCommand(ctx, deps);

    expect(rcon.banUser).not.toHaveBeenCalled();
    expect(banStore.recordBan).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Client 2 is not currently connected — cannot ban.');
  });

  it('prompts for usage when the client id is missing or not a number', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'not-a-number', admin: { telegramId: 1, role: 'admin' } });

    await banCommand(ctx, deps);

    expect(rcon.banUser).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /ban <client id> [reason] [--server <alias>]');
  });
});
