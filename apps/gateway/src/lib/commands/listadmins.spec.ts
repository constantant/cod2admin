import type { Admin } from '@cod2admin/admin-store';
import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { formatAdminsMessage, listAdminsCommand } from './listadmins.js';

const ADMIN: Admin = { telegramId: 1, role: 'owner', addedBy: null, addedAt: new Date() };

describe('formatAdminsMessage', () => {
  it('formats one line per admin', () => {
    expect(formatAdminsMessage([ADMIN])).toBe('1 — owner');
  });

  it('reports no admins configured when the list is empty', () => {
    expect(formatAdminsMessage([])).toBe('No admins configured.');
  });
});

describe('listAdminsCommand', () => {
  it('replies with the formatted admin list', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.listAdmins.mockResolvedValue([ADMIN]);
    const ctx = createFakeCtx();

    await listAdminsCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith('1 — owner');
  });
});
