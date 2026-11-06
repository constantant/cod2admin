import {
  hasPermission,
  type Admin,
  type AdminStore,
  type Permission,
} from '@cod2admin/admin-store';
import type { ActingAdmin, BotContext } from './bot-context.js';

export type NextFunction = () => Promise<void>;

/**
 * Permission gate (docs/PLAN.md §4) — deny by default (§8) for anyone not in `admin-store`, or
 * without the permission. The reply is always `Not authorized.` so a chat can't tell which
 * permission was missing. On success, attaches the resolved admin to `ctx.admin` so handlers can
 * use it for audit logging without a second lookup. `permissions` is the stored list (empty for
 * the owner — `isOwner` is what grants them).
 */
async function lookup(
  ctx: BotContext,
  adminStore: AdminStore,
): Promise<Admin | undefined> {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) {
    await ctx.reply('Not authorized.');
    return undefined;
  }
  const admin = await adminStore.getAdmin(telegramId);
  if (!admin) {
    await ctx.reply('Not authorized.');
    return undefined;
  }
  return admin;
}

async function remember(
  ctx: BotContext,
  adminStore: AdminStore,
  admin: Admin,
): Promise<ActingAdmin> {
  // Remember their current @username/first name so logs can show it — only when it changed,
  // so most commands cost no extra write.
  const username = ctx.from?.username ?? null;
  const firstName = ctx.from?.first_name ?? null;
  if (admin.username !== username || admin.firstName !== firstName) {
    await adminStore.saveTelegramUser({
      telegramId: admin.telegramId,
      username,
      firstName,
    });
  }
  return {
    telegramId: admin.telegramId,
    isOwner: admin.isOwner,
    permissions: [...admin.permissions],
    ...(username ? { username } : {}),
    ...(firstName ? { firstName } : {}),
  };
}

/** Any row in admins. */
export function requireStaff(adminStore: AdminStore) {
  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    const admin = await lookup(ctx, adminStore);
    if (!admin) {
      return;
    }
    ctx.admin = await remember(ctx, adminStore, admin);
    await next();
  };
}

/** `hasPermission` — owner passes every id, including with an empty stored list. */
export function requirePermission(
  permission: Permission,
  adminStore: AdminStore,
) {
  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    const admin = await lookup(ctx, adminStore);
    if (!admin || !hasPermission(admin, permission)) {
      if (admin) {
        await ctx.reply('Not authorized.');
      }
      return;
    }
    ctx.admin = await remember(ctx, adminStore, admin);
    await next();
  };
}
