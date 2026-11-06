import type { Permission } from '@cod2admin/admin-store';
import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { OWNER_ACCESS, sampleAdmin } from '../testing/fake-admin-store.js';
import { permitCommand } from './permit.js';

function withTarget(permissions: Permission[]) {
  const fake = createFakeDeps();
  fake.adminStore.getAdmin.mockImplementation(async (telegramId) =>
    telegramId === 555
      ? sampleAdmin({ telegramId, isOwner: false, permissions })
      : undefined,
  );
  return fake;
}

describe('permitCommand', () => {
  it('lets the owner grant rcon', async () => {
    const { deps, adminStore } = withTarget(['kick']);
    const ctx = createFakeCtx({
      match: '555 kick, rcon',
      admin: { telegramId: 1, ...OWNER_ACCESS },
    });

    await permitCommand(ctx, deps);

    expect(adminStore.setPermissions).toHaveBeenCalledWith(555, [
      'kick',
      'rcon',
    ]);
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'permit',
        target: '555',
        reason: 'kick,rcon',
        source: 'telegram_command',
      }),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      "Set 555's permissions to kick, rcon.",
    );
  });

  it('refuses a non-owner who holds rcon when the target does not', async () => {
    const { deps, adminStore } = withTarget(['kick']);
    const ctx = createFakeCtx({
      match: '555 rcon',
      admin: {
        telegramId: 2,
        isOwner: false,
        permissions: ['admins.manage', 'rcon'],
      },
    });

    await permitCommand(ctx, deps);

    expect(adminStore.setPermissions).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Only the owner can grant rcon.');
  });

  it('keeps rcon when a non-owner leaves it out', async () => {
    const { deps, adminStore } = withTarget(['kick', 'rcon']);
    const ctx = createFakeCtx({
      match: '555 kick, tempban',
      admin: {
        telegramId: 2,
        isOwner: false,
        permissions: ['admins.manage', 'rcon', 'kick', 'tempban'],
      },
    });

    await permitCommand(ctx, deps);

    expect(adminStore.setPermissions).toHaveBeenCalledWith(555, [
      'kick',
      'tempban',
      'rcon',
    ]);
  });

  it('clears permissions when no ids are given, still keeping sticky rcon', async () => {
    const { deps, adminStore } = withTarget(['kick', 'rcon']);
    const ctx = createFakeCtx({
      match: '',
      replyToUserId: 555,
      admin: {
        telegramId: 2,
        isOwner: false,
        permissions: ['admins.manage', 'kick'],
      },
    });

    await permitCommand(ctx, deps);

    expect(adminStore.setPermissions).toHaveBeenCalledWith(555, ['rcon']);
  });

  it('prompts for usage when no target is given', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({
      match: '',
      admin: { telegramId: 1, ...OWNER_ACCESS },
    });

    await permitCommand(ctx, deps);

    expect(adminStore.setPermissions).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      'Usage: /permit <telegram-id-or-reply> [kick, tempban, ...]',
    );
  });
});
