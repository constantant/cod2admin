import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { removeAdminCommand } from './removeadmin.js';

describe('removeAdminCommand', () => {
  it('removes an admin by raw telegram id', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '555', admin: { telegramId: 1, role: 'owner' } });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).toHaveBeenCalledWith(555);
    expect(ctx.reply).toHaveBeenCalledWith('Removed 555 from admins.');
  });

  it('resolves the target via reply', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', replyToUserId: 777, admin: { telegramId: 1, role: 'owner' } });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).toHaveBeenCalledWith(777);
  });

  it('prompts for usage when no target is given', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', admin: { telegramId: 1, role: 'owner' } });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /removeadmin <telegram-id-or-reply>');
  });
});
