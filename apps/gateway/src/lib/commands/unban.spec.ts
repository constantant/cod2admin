import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { unbanCommand } from './unban.js';

const ADMIN = { telegramId: 1, role: 'admin' as const };

describe('unbanCommand', () => {
  it('lifts a GUID ban on every server: clears it from the store, asks each server to unbanUser it, and audit-logs it', async () => {
    const { deps, rcon, banStore, adminStore } = createFakeDeps();
    const other = createFakeRcon();
    deps.rconClients.set('other', asRconClient(other));
    const ctx = createFakeCtx({ match: 'GUID123', admin: ADMIN });

    await unbanCommand(ctx, deps);

    expect(banStore.unbanByGuid).toHaveBeenCalledWith('GUID123');
    expect(rcon.unbanUser).toHaveBeenCalledWith('GUID123');
    expect(other.unbanUser).toHaveBeenCalledWith('GUID123');
    expect(banStore.unbanIp).not.toHaveBeenCalled();
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'unban', target: 'GUID123', serverAlias: null }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('Unbanned GUID GUID123 on all servers.');
  });

  it('names a server that did not answer, so the admin knows to retry', async () => {
    const { deps } = createFakeDeps();
    const down = createFakeRcon();
    down.unbanUser.mockRejectedValue(new Error('timed out'));
    deps.rconClients.set('down', asRconClient(down));
    const ctx = createFakeCtx({ match: 'GUID123', admin: ADMIN });

    await unbanCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("down didn't answer"));
  });

  it('lifts an IP ban in the store only, without any rcon call', async () => {
    const { deps, rcon, banStore, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '1.2.3.4', admin: ADMIN });

    await unbanCommand(ctx, deps);

    expect(rcon.unbanUser).not.toHaveBeenCalled();
    expect(banStore.unbanIp).toHaveBeenCalledWith('1.2.3.4');
    expect(banStore.unbanByGuid).not.toHaveBeenCalled();
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'unban', target: '1.2.3.4' }));
    expect(ctx.reply).toHaveBeenCalledWith('Unbanned IP 1.2.3.4 on all servers.');
  });

  it('says so when the bot had no active ban recorded for the target', async () => {
    const { deps, banStore } = createFakeDeps();
    banStore.unbanIp.mockResolvedValue(0);
    const ctx = createFakeCtx({ match: '1.2.3.4', admin: ADMIN });

    await unbanCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith('No active ban for IP 1.2.3.4 was recorded by the bot.');
  });

  it('ignores a --server flag, since bans are global', async () => {
    const { deps, banStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '1.2.3.4 --server nope', admin: ADMIN });

    await unbanCommand(ctx, deps);

    expect(banStore.unbanIp).toHaveBeenCalledWith('1.2.3.4');
  });

  it('prompts for usage when no target is given', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: ADMIN });

    await unbanCommand(ctx, deps);

    expect(rcon.unbanUser).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /unban <guid-or-ip>');
  });
});
