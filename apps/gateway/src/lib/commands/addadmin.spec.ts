import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { addAdminCommand } from './addadmin.js';

describe('addAdminCommand', () => {
  it('adds a moderator by raw telegram id', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '555 moderator', admin: { telegramId: 1, role: 'owner' } });

    await addAdminCommand(ctx, deps);

    expect(adminStore.addAdmin).toHaveBeenCalledWith(555, 'moderator', 1);
    expect(ctx.reply).toHaveBeenCalledWith('Added 555 as moderator.');
  });

  it('resolves the target via reply instead of a raw id when replying to a message', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'moderator', replyToUserId: 777, admin: { telegramId: 1, role: 'owner' } });

    await addAdminCommand(ctx, deps);

    expect(adminStore.addAdmin).toHaveBeenCalledWith(777, 'moderator', 1);
  });

  it('lets an admin (not owner) add a moderator', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '555 moderator', admin: { telegramId: 2, role: 'admin' } });

    await addAdminCommand(ctx, deps);

    expect(adminStore.addAdmin).toHaveBeenCalledWith(555, 'moderator', 2);
  });

  it('refuses to let a non-owner admin grant the admin role', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '555 admin', admin: { telegramId: 2, role: 'admin' } });

    await addAdminCommand(ctx, deps);

    expect(adminStore.addAdmin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Only the owner can grant the admin role. You can add moderators.');
  });

  it('lets the owner grant the admin role', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '555 admin', admin: { telegramId: 1, role: 'owner' } });

    await addAdminCommand(ctx, deps);

    expect(adminStore.addAdmin).toHaveBeenCalledWith(555, 'admin', 1);
  });

  it('prompts for usage on an invalid role', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '555 owner', admin: { telegramId: 1, role: 'owner' } });

    await addAdminCommand(ctx, deps);

    expect(adminStore.addAdmin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /addadmin <telegram-id-or-reply> <admin|moderator>');
  });
});
