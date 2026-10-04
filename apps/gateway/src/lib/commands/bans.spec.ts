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
      { id: 2, serverAlias: 'other', ip: '1.2.3.4', reason: null, bannedBy: 1, bannedAt: new Date(), expiresAt: null, unbannedAt: null },
    ]);
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'admin' } });

    await bansCommand(ctx, deps);

    expect(banStore.listActiveBans).toHaveBeenCalledWith();
    expect(banStore.listActiveIpBans).toHaveBeenCalledWith();
    expect(ctx.reply).toHaveBeenCalledWith(
      [
        'Active bans (they apply on all servers):',
        '',
        'GUID bans:',
        'GUID123 — Cheater (aimbot) — permanent — banned on default',
        '',
        'IP bans:',
        '1.2.3.4 — permanent — banned on other',
      ].join('\n'),
    );
  });

  it('reports no active bans', async () => {
    const { deps } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'admin' } });

    await bansCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith('No active bans.');
  });
});
