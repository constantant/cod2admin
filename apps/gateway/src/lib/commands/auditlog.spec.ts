import type { AuditLogEntry } from '@cod2admin/admin-store';
import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { auditLogCommand, formatAuditLogMessage } from './auditlog.js';

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
