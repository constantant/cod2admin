import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { bansCommand } from './bans.js';

describe('bansCommand', () => {
  it('replies with active GUID and IP bans', async () => {
    const { deps, banStore } = createFakeDeps();
    banStore.listActiveBans.mockResolvedValue([
      {
        id: 1,
        serverAlias: 'default',
        guid: 'GUID123',
        name: 'Cheater',
        reason: 'aimbot',
        bannedBy: 1,
        bannedAt: new Date(),
        expiresAt: null,
        unbannedAt: null,
      },
    ]);
    banStore.listActiveIpBans.mockResolvedValue([
      { id: 2, serverAlias: 'default', ip: '1.2.3.4', reason: null, bannedBy: 1, bannedAt: new Date(), expiresAt: null, unbannedAt: null },
    ]);
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'admin' } });

    await bansCommand(ctx, deps);

    expect(banStore.listActiveBans).toHaveBeenCalledWith('default');
    expect(banStore.listActiveIpBans).toHaveBeenCalledWith('default');
    expect(ctx.reply).toHaveBeenCalledWith('GUID bans:\nGUID123 — Cheater (aimbot) — permanent\n\nIP bans:\n1.2.3.4 — permanent');
  });

  it('reports no active bans', async () => {
    const { deps } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'admin' } });

    await bansCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith('No active bans.');
  });
});
