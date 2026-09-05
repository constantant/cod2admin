import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { setRoleCommand } from './setrole.js';

describe('setRoleCommand', () => {
  it('sets a role by raw telegram id', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '555 admin', admin: { telegramId: 1, role: 'owner' } });

    await setRoleCommand(ctx, deps);

    expect(adminStore.setRole).toHaveBeenCalledWith(555, 'admin');
    expect(ctx.reply).toHaveBeenCalledWith("Set 555's role to admin.");
  });

  it('resolves the target via reply, with only the role as an argument', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'moderator', replyToUserId: 777, admin: { telegramId: 1, role: 'owner' } });

    await setRoleCommand(ctx, deps);

    expect(adminStore.setRole).toHaveBeenCalledWith(777, 'moderator');
  });

  it('refuses to let a non-owner admin grant the admin role', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '555 admin', admin: { telegramId: 2, role: 'admin' } });

    await setRoleCommand(ctx, deps);

    expect(adminStore.setRole).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Only the owner can grant the admin role.');
  });
});
