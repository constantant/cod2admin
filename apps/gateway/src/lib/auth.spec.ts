import { describe, expect, it, vi } from 'vitest';
import { requirePermission, requireStaff } from './auth.js';
import { createFakeCtx } from './testing/fake-ctx.js';
import {
  ADMIN_ACCESS,
  MODERATOR_ACCESS,
  createFakeAdminStore,
  sampleAdmin,
} from './testing/fake-admin-store.js';

describe('requireStaff / requirePermission', () => {
  it('calls next() and attaches the stored admin for any staff member', async () => {
    const adminStore = createFakeAdminStore({
      admins: [sampleAdmin({ telegramId: 42, ...ADMIN_ACCESS })],
    });
    const middleware = requireStaff(adminStore);
    const ctx = createFakeCtx({ from: { id: 42 } });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.admin).toEqual({
      telegramId: 42,
      isOwner: false,
      permissions: ADMIN_ACCESS.permissions,
    });
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("saves the admin's Telegram name when it changed and attaches it to ctx.admin", async () => {
    const adminStore = createFakeAdminStore({
      admins: [
        sampleAdmin({ telegramId: 42, ...ADMIN_ACCESS, username: 'old' }),
      ],
    });
    const middleware = requireStaff(adminStore);
    const ctx = createFakeCtx({
      from: { id: 42, username: 'new', first_name: 'Kostya' },
    });

    await middleware(ctx, vi.fn().mockResolvedValue(undefined));

    expect(adminStore.saveTelegramUser).toHaveBeenCalledWith({
      telegramId: 42,
      username: 'new',
      firstName: 'Kostya',
    });
    expect(ctx.admin).toEqual({
      telegramId: 42,
      isOwner: false,
      permissions: ADMIN_ACCESS.permissions,
      username: 'new',
      firstName: 'Kostya',
    });
  });

  it("doesn't rewrite the admin's Telegram name when it's unchanged", async () => {
    const adminStore = createFakeAdminStore({
      admins: [
        sampleAdmin({
          telegramId: 42,
          ...ADMIN_ACCESS,
          username: 'nick',
          firstName: 'Kostya',
        }),
      ],
    });
    const middleware = requireStaff(adminStore);
    const ctx = createFakeCtx({
      from: { id: 42, username: 'nick', first_name: 'Kostya' },
    });

    await middleware(ctx, vi.fn().mockResolvedValue(undefined));

    expect(adminStore.saveTelegramUser).not.toHaveBeenCalled();
  });

  it('lets a moderator-shaped set kick, and refuses ban', async () => {
    const adminStore = createFakeAdminStore({
      admins: [sampleAdmin({ telegramId: 5, ...MODERATOR_ACCESS })],
    });
    const kickCtx = createFakeCtx({ from: { id: 5 } });
    const kickNext = vi.fn().mockResolvedValue(undefined);
    await requirePermission('kick', adminStore)(kickCtx, kickNext);
    expect(kickNext).toHaveBeenCalledOnce();

    const banCtx = createFakeCtx({ from: { id: 5 } });
    const banNext = vi.fn().mockResolvedValue(undefined);
    await requirePermission('ban', adminStore)(banCtx, banNext);
    expect(banNext).not.toHaveBeenCalled();
    expect(banCtx.reply).toHaveBeenCalledWith('Not authorized.');
    expect(adminStore.saveTelegramUser).not.toHaveBeenCalled();
  });

  it('lets the owner through requirePermission(rcon) with an empty stored list', async () => {
    const adminStore = createFakeAdminStore({
      admins: [sampleAdmin({ telegramId: 1, isOwner: true, permissions: [] })],
    });
    const middleware = requirePermission('rcon', adminStore);
    const ctx = createFakeCtx({ from: { id: 1 } });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.admin).toEqual({
      telegramId: 1,
      isOwner: true,
      permissions: [],
    });
  });

  it('denies anyone not found in admin-store', async () => {
    const adminStore = createFakeAdminStore();
    const middleware = requireStaff(adminStore);
    const ctx = createFakeCtx({ from: { id: 999 } });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Not authorized.');
  });

  it('denies updates with no `from` (e.g. channel posts)', async () => {
    const adminStore = createFakeAdminStore();
    const middleware = requireStaff(adminStore);
    const ctx = createFakeCtx({ from: undefined });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(adminStore.getAdmin).not.toHaveBeenCalled();
  });
});
