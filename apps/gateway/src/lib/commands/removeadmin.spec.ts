import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { sampleAdmin } from '../testing/fake-admin-store.js';
import { removeAdminCommand } from './removeadmin.js';

/** 1 owner, 2 and 4 admins, 555 and 777 moderators. */
function withTargets() {
  const fake = createFakeDeps();
  fake.adminStore.getAdmin.mockImplementation(async (telegramId) => {
    const role =
      telegramId === 1
        ? 'owner'
        : telegramId === 2 || telegramId === 4
          ? 'admin'
          : telegramId === 555 || telegramId === 777
            ? 'moderator'
            : undefined;
    return role ? sampleAdmin({ telegramId, role }) : undefined;
  });
  return fake;
}

describe('removeAdminCommand', () => {
  it('removes an admin by raw telegram id', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({
      match: '555',
      admin: { telegramId: 1, role: 'owner' },
    });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).toHaveBeenCalledWith(555);
    expect(ctx.reply).toHaveBeenCalledWith('Removed 555 from admins.');
  });

  it('resolves the target via reply', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({
      match: '',
      replyToUserId: 777,
      admin: { telegramId: 1, role: 'owner' },
    });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).toHaveBeenCalledWith(777);
  });

  it('prompts for usage when no target is given', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({
      match: '',
      admin: { telegramId: 1, role: 'owner' },
    });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      'Usage: /removeadmin <telegram-id-or-reply>',
    );
  });

  it.each([
    ['the owner, as an admin', 2, 'admin', 1, "You can't change the owner."],
    [
      'another admin, as an admin',
      2,
      'admin',
      4,
      "You can't change another admin.",
    ],
    ['themselves', 2, 'admin', 2, "You can't change your own role."],
    [
      'themselves, as the owner',
      1,
      'owner',
      1,
      "You can't change your own role.",
    ],
  ] as const)(
    'refuses to change %s',
    async (_who, actorId, role, targetId, reply) => {
      const { deps, adminStore } = withTargets();
      const ctx = createFakeCtx({
        match: `${targetId}`,
        admin: { telegramId: actorId, role },
      });

      await removeAdminCommand(ctx, deps);

      expect(adminStore.removeAdmin).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(reply);
    },
  );

  it('says so when the target is not an admin', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({
      match: `999`,
      admin: { telegramId: 1, role: 'owner' },
    });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).not.toHaveBeenCalled();
  });

  it('lets an admin change a moderator', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({
      match: `555`,
      admin: { telegramId: 2, role: 'admin' },
    });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).toHaveBeenCalled();
  });
});
