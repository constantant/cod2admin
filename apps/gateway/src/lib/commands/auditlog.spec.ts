import type { AuditLogEntry } from '@cod2admin/admin-store';
import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { auditLogCommand, formatAuditLogMessage, formatAuditLogReport } from './auditlog.js';

const ENTRY: AuditLogEntry = {
  id: 1,
  actorTelegramId: 1,
  action: 'kick',
  target: 'PlayerOne',
  serverAlias: 'default',
  reason: null,
  source: 'telegram_command',
  detailJson: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  actorUsername: null,
  actorFirstName: null,
};

describe('formatAuditLogMessage', () => {
  it('formats one line per entry', () => {
    expect(formatAuditLogMessage([ENTRY])).toBe('2026-01-01T00:00:00.000Z · 1 · kick → PlayerOne');
  });

  it('names the actor by @username, else first name, keeping the ID', () => {
    expect(formatAuditLogMessage([{ ...ENTRY, actorUsername: 'nick', actorFirstName: 'Kostya' }])).toBe(
      '2026-01-01T00:00:00.000Z · @nick (1) · kick → PlayerOne',
    );
    expect(formatAuditLogMessage([{ ...ENTRY, actorFirstName: 'Kostya' }])).toBe(
      '2026-01-01T00:00:00.000Z · Kostya (1) · kick → PlayerOne',
    );
  });

  it('reports no entries when the list is empty', () => {
    expect(formatAuditLogMessage([])).toBe('No audit log entries.');
  });
});

describe('auditLogCommand', () => {
  it('defaults to 10 entries when no count is given', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '' });

    await auditLogCommand(ctx, deps);

    expect(adminStore.listAuditLog).toHaveBeenCalledWith(10);
  });

  it('uses the requested count, capped at 50', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '500' });

    await auditLogCommand(ctx, deps);

    expect(adminStore.listAuditLog).toHaveBeenCalledWith(50);
  });
});

describe('long /auditlog', () => {
  const entries: AuditLogEntry[] = Array.from({ length: 20 }, (_, i) => ({
    ...ENTRY,
    id: i,
    target: i === 0 ? 'Name|With|Pipes' : `Player${i}`,
    createdAt: new Date(Date.UTC(2026, 9, 7, 10, 59 - i)),
  }));

  it('shows the newest five and attaches all of them', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.listAuditLog.mockResolvedValue(entries);
    const ctx = createFakeCtx({ match: '20', admin: { telegramId: 1, role: 'owner' } });

    await auditLogCommand(ctx, deps);

    const [, other] = vi.mocked(ctx.replyWithDocument!).mock.calls[0]!;
    const caption = (other as { caption: string }).caption;
    expect(caption.startsWith('Audit log — last 20 entries, newest 5 shown:')).toBe(true);
    expect(caption).toContain('Player4');
    expect(caption).not.toContain('Player5');
  });

  it('puts every entry in the report table', () => {
    const report = formatAuditLogReport(entries, new Date('2026-10-07T11:00:00Z'));

    expect(report.split('\n').filter((line) => line.startsWith('| 2026-'))).toHaveLength(20);
    expect(report).toContain('| 2026-10-07 10:59:00 | 1 | kick | Name\\|With\\|Pipes | default | — | telegram_command |');
    expect(report).not.toContain('DB-IP');
  });
});
