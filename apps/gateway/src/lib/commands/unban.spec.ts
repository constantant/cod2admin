import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { sampleGuidBan } from '../testing/fake-ban-store.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { unbanCommand } from './unban.js';

const ADMIN = { telegramId: 1, role: 'admin' as const };

describe('unbanCommand', () => {
  it('lifts a GUID ban: clears it from the store, removes it by name from the issuing server ban.txt, and audit-logs it', async () => {
    const { deps, rcon, banStore, adminStore } = createFakeDeps();
    const other = createFakeRcon();
    deps.rconClients.set('other', asRconClient(other));
    const ban = sampleGuidBan({ id: 5, name: '^1Cheater' });
    banStore.listBansByGuid.mockResolvedValue([ban]);
    banStore.unbanByGuid.mockResolvedValue([ban]);
    const ctx = createFakeCtx({ match: 'GUID123', admin: ADMIN });

    await unbanCommand(ctx, deps);

    expect(banStore.unbanByGuid).toHaveBeenCalledWith('GUID123');
    // `unbanUser` matches by name, not GUID (docs/PLAN.md §2.4 "ban.txt"), and only the issuing
    // server's ban.txt can have the entry.
    expect(rcon.unbanUser).toHaveBeenCalledWith('^1Cheater');
    expect(other.unbanUser).not.toHaveBeenCalled();
    expect(banStore.unbanIp).not.toHaveBeenCalled();
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'unban', target: 'GUID123', serverAlias: null }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('Unbanned GUID GUID123 on all servers.');
  });

  it('skips ban.txt for temp bans and names that were never written there', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    const bans = [
      sampleGuidBan({ id: 1, expiresAt: new Date('2099-01-01T00:00:00.000Z') }),
      sampleGuidBan({ id: 2, name: 'Вика' }),
      sampleGuidBan({ id: 3, serverAlias: 'removed' }),
    ];
    banStore.listBansByGuid.mockResolvedValue(bans);
    banStore.unbanByGuid.mockResolvedValue(bans);
    const ctx = createFakeCtx({ match: 'GUID123', admin: ADMIN });

    await unbanCommand(ctx, deps);

    expect(rcon.unbanUser).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Unbanned GUID GUID123 on all servers.');
  });

  it('retries ban.txt from the ban history even once the bot has already lifted the ban', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    banStore.listBansByGuid.mockResolvedValue([sampleGuidBan({ unbannedAt: new Date() })]);
    const ctx = createFakeCtx({ match: 'GUID123', admin: ADMIN });

    await unbanCommand(ctx, deps);

    expect(rcon.unbanUser).toHaveBeenCalledWith('Cheater');
    expect(ctx.reply).toHaveBeenCalledWith('No active ban for GUID GUID123 was recorded by the bot.');
  });

  it('names a server that did not answer, so the admin knows to retry', async () => {
    const { deps, banStore } = createFakeDeps();
    const down = createFakeRcon();
    down.unbanUser.mockRejectedValue(new Error('timed out'));
    deps.rconClients.set('down', asRconClient(down));
    const ban = sampleGuidBan({ serverAlias: 'down' });
    banStore.listBansByGuid.mockResolvedValue([ban]);
    banStore.unbanByGuid.mockResolvedValue([ban]);
    const ctx = createFakeCtx({ match: 'GUID123', admin: ADMIN });

    await unbanCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("down didn't answer"));
  });

  it('says so when ban.txt had no entry for a ban it just lifted', async () => {
    const { deps, rcon, banStore } = createFakeDeps();
    rcon.unbanUser.mockResolvedValue(0);
    const ban = sampleGuidBan();
    banStore.listBansByGuid.mockResolvedValue([ban]);
    banStore.unbanByGuid.mockResolvedValue([ban]);
    const ctx = createFakeCtx({ match: 'GUID123', admin: ADMIN });

    await unbanCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(
      'Unbanned GUID GUID123 on all servers.\nNo ban.txt entry to remove on default (Cheater).',
    );
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
