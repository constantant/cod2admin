import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import type { Ban, BanIp } from '@cod2admin/ban-store';
import { bansCommand, formatBansReport, formatBansSummary } from './bans.js';

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

describe('long /bans', () => {
  const NOW = new Date('2026-10-07T10:00:00Z');
  const guidBans: Ban[] = Array.from({ length: 4 }, (_, i) => ({
    id: i,
    serverAlias: 'ctfrussia',
    guid: String(700000 + i),
    name: `Cheater${i}`,
    reason: i === 0 ? 'aim|bot' : null,
    bannedBy: 213238280,
    bannedAt: new Date(NOW.getTime() - i * 3_600_000),
    expiresAt: null,
    unbannedAt: null,
  }));
  const ipBans: BanIp[] = Array.from({ length: 10 }, (_, i) => ({
    id: 100 + i,
    serverAlias: 'ctf2',
    ip: `5.9.10.${i}`,
    reason: null,
    bannedBy: 213238280,
    bannedAt: new Date(NOW.getTime() - (i + 10) * 3_600_000),
    expiresAt: i < 3 ? new Date(NOW.getTime() + 86_400_000) : null,
    unbannedAt: null,
  }));

  it('summarises counts and the newest five', () => {
    const summary = formatBansSummary(guidBans, ipBans);

    expect(summary.split('\n').slice(0, 2)).toEqual([
      'Active bans: 14 (they apply on all servers)',
      'GUID 4 · IP 10 · permanent 11 · temporary 3',
    ]);
    expect(summary).toContain('Newest 5:\n700000 — Cheater0 (aim|bot)');
    expect(summary).toContain('5.9.10.0 — expires');
    expect(summary).not.toContain('5.9.10.1 ');
  });

  it('lists every ban in the report, newest first, escaping reasons', () => {
    const report = formatBansReport(guidBans, ipBans, { lookup: () => ({ code: 'DE', name: 'Germany' }) }, NOW);
    const rows = report.split('\n').filter((line) => /^\| (GUID|IP) \|/.test(line));

    expect(rows).toHaveLength(14);
    expect(rows[0]).toBe('| GUID | 700000 | Cheater0 | aim\\|bot | 2026-10-07 10:00 | permanent | 213238280 | ctfrussia |');
    expect(rows[13]).toContain('| IP | 5.9.10.9 | 🇩🇪 Germany |');
    expect(report).toContain('DB-IP.com');
  });

  it('attaches the report through the command when the list is long', async () => {
    const { deps, banStore } = createFakeDeps();
    banStore.listActiveBans.mockResolvedValue(guidBans);
    banStore.listActiveIpBans.mockResolvedValue(ipBans);
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'admin' } });

    await bansCommand(ctx, deps);

    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.replyWithDocument).toHaveBeenCalledTimes(1);
  });
});
