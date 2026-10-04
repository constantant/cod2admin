import { describe, expect, it, vi } from 'vitest';
import { requireRole } from './auth.js';
import { createFakeAdminStore, sampleAdmin } from './testing/fake-admin-store.js';
import { createFakeCtx } from './testing/fake-ctx.js';

describe('requireRole', () => {
  it('calls next() and attaches ctx.admin when the actor meets the required role', async () => {
    const adminStore = createFakeAdminStore({ admins: [sampleAdmin({ telegramId: 42, role: 'admin' })] });
    const middleware = requireRole('admin', adminStore);
    const ctx = createFakeCtx({ from: { id: 42 } });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.admin).toEqual({ telegramId: 42, role: 'admin' });
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("saves the admin's Telegram name when it changed and attaches it to ctx.admin", async () => {
    const adminStore = createFakeAdminStore({ admins: [sampleAdmin({ telegramId: 42, role: 'admin', username: 'old' })] });
    const middleware = requireRole('admin', adminStore);
    const ctx = createFakeCtx({ from: { id: 42, username: 'new', first_name: 'Kostya' } });

    await middleware(ctx, vi.fn().mockResolvedValue(undefined));

    expect(adminStore.saveTelegramUser).toHaveBeenCalledWith({ telegramId: 42, username: 'new', firstName: 'Kostya' });
    expect(ctx.admin).toEqual({ telegramId: 42, role: 'admin', username: 'new', firstName: 'Kostya' });
  });

  it("doesn't rewrite the admin's Telegram name when it's unchanged", async () => {
    const adminStore = createFakeAdminStore({
      admins: [sampleAdmin({ telegramId: 42, role: 'admin', username: 'nick', firstName: 'Kostya' })],
    });
    const middleware = requireRole('admin', adminStore);
    const ctx = createFakeCtx({ from: { id: 42, username: 'nick', first_name: 'Kostya' } });

    await middleware(ctx, vi.fn().mockResolvedValue(undefined));

    expect(adminStore.saveTelegramUser).not.toHaveBeenCalled();
  });

  it('allows a higher-ranked role through a lower-rank gate', async () => {
    const adminStore = createFakeAdminStore({ admins: [sampleAdmin({ telegramId: 1, role: 'owner' })] });
    const middleware = requireRole('moderator', adminStore);
    const ctx = createFakeCtx({ from: { id: 1 } });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('denies a lower-ranked role at a higher-rank gate', async () => {
    const adminStore = createFakeAdminStore({ admins: [sampleAdmin({ telegramId: 5, role: 'moderator' })] });
    const middleware = requireRole('admin', adminStore);
    const ctx = createFakeCtx({ from: { id: 5 } });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Not authorized.');
  });

  it('denies anyone not found in admin-store', async () => {
    const adminStore = createFakeAdminStore();
    const middleware = requireRole('moderator', adminStore);
    const ctx = createFakeCtx({ from: { id: 999 } });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Not authorized.');
  });

  it('denies updates with no `from` (e.g. channel posts)', async () => {
    const adminStore = createFakeAdminStore();
    const middleware = requireRole('moderator', adminStore);
    const ctx = createFakeCtx({ from: undefined });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(adminStore.getAdmin).not.toHaveBeenCalled();
  });
});
