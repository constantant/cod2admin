import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { sampleAdmin } from '../testing/fake-admin-store.js';
import { setRoleCommand } from './setrole.js';

/** 1 owner, 2 and 4 admins, 555 and 777 moderators. */
function withTargets() {
  const fake = createFakeDeps();
  fake.adminStore.getAdmin.mockImplementation(async (telegramId) => {
    const role = telegramId === 1 ? 'owner' : telegramId === 2 || telegramId === 4 ? 'admin' : telegramId === 555 || telegramId === 777 ? 'moderator' : undefined;
    return role ? sampleAdmin({ telegramId, role }) : undefined;
  });
  return fake;
}

describe('setRoleCommand', () => {
  it('sets a role by raw telegram id', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({ match: '555 admin', admin: { telegramId: 1, role: 'owner' } });

    await setRoleCommand(ctx, deps);

    expect(adminStore.setRole).toHaveBeenCalledWith(555, 'admin');
    expect(ctx.reply).toHaveBeenCalledWith("Set 555's role to admin.");
  });

  it('resolves the target via reply, with only the role as an argument', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({ match: 'moderator', replyToUserId: 777, admin: { telegramId: 1, role: 'owner' } });

    await setRoleCommand(ctx, deps);

    expect(adminStore.setRole).toHaveBeenCalledWith(777, 'moderator');
  });

  it('refuses to let a non-owner admin grant the admin role', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({ match: '555 admin', admin: { telegramId: 2, role: 'admin' } });

    await setRoleCommand(ctx, deps);

    expect(adminStore.setRole).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Only the owner can grant the admin role.');
  });

  it.each([
    ['the owner, as an admin', 2, 'admin', 1, "You can't change the owner."],
    ['another admin, as an admin', 2, 'admin', 4, "You can't change another admin."],
    ['themselves', 2, 'admin', 2, "You can't change your own role."],
    ['themselves, as the owner', 1, 'owner', 1, "You can't change your own role."],
  ] as const)('refuses to change %s', async (_who, actorId, role, targetId, reply) => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({ match: `${targetId} moderator`, admin: { telegramId: actorId, role } });

    await setRoleCommand(ctx, deps);

    expect(adminStore.setRole).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(reply);
  });

  it('says so when the target is not an admin', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({ match: `999 moderator`, admin: { telegramId: 1, role: 'owner' } });

    await setRoleCommand(ctx, deps);

    expect(adminStore.setRole).not.toHaveBeenCalled();
  });

  it('lets an admin change a moderator', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({ match: `555 moderator`, admin: { telegramId: 2, role: 'admin' } });

    await setRoleCommand(ctx, deps);

    expect(adminStore.setRole).toHaveBeenCalled();
  });
});
