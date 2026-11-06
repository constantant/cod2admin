import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { OWNER_ACCESS, sampleAdmin } from '../testing/fake-admin-store.js';
import { addAdminCommand } from './addadmin.js';

const OWNER = { telegramId: 1, ...OWNER_ACCESS };

describe('addAdminCommand', () => {
  it('adds someone with no permissions by raw telegram id', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '555', admin: OWNER });

    await addAdminCommand(ctx, deps);

    expect(adminStore.addAdmin).toHaveBeenCalledWith(555, [], 1);
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'addadmin',
        target: '555',
        source: 'telegram_command',
      }),
    );
    expect(ctx.reply).toHaveBeenCalledWith('Added 555.');
  });

  it('resolves the target via reply instead of a raw id when replying to a message', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({
      match: '',
      replyToUserId: 777,
      admin: OWNER,
    });

    await addAdminCommand(ctx, deps);

    expect(adminStore.addAdmin).toHaveBeenCalledWith(777, [], 1);
  });

  it('does not change someone who is already staff', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.getAdmin.mockResolvedValue(
      sampleAdmin({
        telegramId: 555,
        ...OWNER_ACCESS,
        isOwner: false,
        permissions: ['kick'],
      }),
    );
    const ctx = createFakeCtx({ match: '555', admin: OWNER });

    await addAdminCommand(ctx, deps);

    expect(adminStore.addAdmin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      '555 is already staff. Change their permissions with /permit.',
    );
  });

  it('prompts for usage when no telegram id is given', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: OWNER });

    await addAdminCommand(ctx, deps);

    expect(adminStore.addAdmin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      'Usage: /addadmin <telegram-id-or-reply>',
    );
  });
});
