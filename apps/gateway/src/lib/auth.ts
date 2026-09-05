import type { AdminRole, AdminStore } from '@cod2admin/admin-store';
import type { BotContext } from './bot-context.js';

export type NextFunction = () => Promise<void>;

const ROLE_RANK: Record<AdminRole, number> = { moderator: 1, admin: 2, owner: 3 };

/**
 * Role-gated middleware (docs/PLAN.md §4) — deny by default (§8) for anyone not in `admin-store`
 * or below `minRole`. On success, attaches the resolved admin to `ctx.admin` so handlers can use
 * it for audit logging without a second lookup.
 */
export function requireRole(minRole: AdminRole, adminStore: AdminStore) {
  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    const telegramId = ctx.from?.id;
    if (telegramId === undefined) {
      await ctx.reply('Not authorized.');
      return;
    }
    const admin = await adminStore.getAdmin(telegramId);
    if (!admin || ROLE_RANK[admin.role] < ROLE_RANK[minRole]) {
      await ctx.reply('Not authorized.');
      return;
    }
    ctx.admin = { telegramId: admin.telegramId, role: admin.role };
    await next();
  };
}
