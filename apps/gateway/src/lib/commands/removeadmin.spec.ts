import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import {
  ADMIN_ACCESS,
  MODERATOR_ACCESS,
  OWNER_ACCESS,
  sampleAdmin,
} from '../testing/fake-admin-store.js';
import { removeAdminCommand } from './removeadmin.js';

/** 1 owner, 2 and 4 on the admin template, 555 and 777 on the moderator template. */
function withTargets() {
  const fake = createFakeDeps();
  fake.adminStore.getAdmin.mockImplementation(async (telegramId) => {
    const access =
      telegramId === 1
        ? OWNER_ACCESS
        : telegramId === 2 || telegramId === 4
          ? ADMIN_ACCESS
          : telegramId === 555 || telegramId === 777
            ? MODERATOR_ACCESS
            : undefined;
    return access ? sampleAdmin({ telegramId, ...access }) : undefined;
  });
  return fake;
}

const OWNER = { telegramId: 1, ...OWNER_ACCESS };
const ADMIN = { telegramId: 2, ...ADMIN_ACCESS };

describe('removeAdminCommand', () => {
  it('removes an admin by raw telegram id', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({ match: '555', admin: OWNER });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).toHaveBeenCalledWith(555);
    expect(ctx.reply).toHaveBeenCalledWith('Removed 555 from admins.');
  });

  it('resolves the target via reply', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({
      match: '',
      replyToUserId: 777,
      admin: OWNER,
    });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).toHaveBeenCalledWith(777);
  });

  it('prompts for usage when no target is given', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({ match: '', admin: OWNER });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      'Usage: /removeadmin <telegram-id-or-reply>',
    );
  });

  it.each([
    ['the owner, as an admin', ADMIN, 1, "You can't change the owner."],
    ['themselves', ADMIN, 2, "You can't change your own permissions."],
    [
      'themselves, as the owner',
      OWNER,
      1,
      "You can't change your own permissions.",
    ],
  ] as const)('refuses to change %s', async (_who, actor, targetId, reply) => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({
      match: `${targetId}`,
      admin: actor,
    });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(reply);
  });

  it('says so when the target is not an admin', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({ match: '999', admin: OWNER });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).not.toHaveBeenCalled();
  });

  it('lets an admin remove another admin', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({ match: '4', admin: ADMIN });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).toHaveBeenCalledWith(4);
  });

  it('lets an admin remove a moderator', async () => {
    const { deps, adminStore } = withTargets();
    const ctx = createFakeCtx({ match: '555', admin: ADMIN });

    await removeAdminCommand(ctx, deps);

    expect(adminStore.removeAdmin).toHaveBeenCalled();
  });
});
