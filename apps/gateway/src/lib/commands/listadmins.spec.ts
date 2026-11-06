import type { Admin } from '@cod2admin/admin-store';
import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { OWNER_ACCESS, sampleAdmin } from '../testing/fake-admin-store.js';
import { formatAdminsMessage, listAdminsCommand } from './listadmins.js';

const OWNER: Admin = sampleAdmin({
  telegramId: 1,
  ...OWNER_ACCESS,
  addedBy: null,
  username: null,
  firstName: null,
});

describe('formatAdminsMessage', () => {
  it('prints owner for the owner', () => {
    expect(formatAdminsMessage([OWNER])).toBe('1 — owner');
  });

  it('names the owner by @username when known', () => {
    expect(formatAdminsMessage([{ ...OWNER, username: 'nick' }])).toBe(
      '@nick (1) — owner',
    );
  });

  it('prints comma-separated permission ids', () => {
    expect(
      formatAdminsMessage([
        sampleAdmin({
          telegramId: 2,
          isOwner: false,
          permissions: ['kick', 'ban'],
        }),
      ]),
    ).toBe('2 — kick, ban');
  });

  it('prints none when a staff member has no permissions', () => {
    expect(
      formatAdminsMessage([
        sampleAdmin({ telegramId: 3, isOwner: false, permissions: [] }),
      ]),
    ).toBe('3 — none');
  });

  it('reports no admins configured when the list is empty', () => {
    expect(formatAdminsMessage([])).toBe('No admins configured.');
  });
});

describe('listAdminsCommand', () => {
  it('replies with the formatted admin list', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.listAdmins.mockResolvedValue([OWNER]);
    const ctx = createFakeCtx();

    await listAdminsCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith('1 — owner');
  });
});
