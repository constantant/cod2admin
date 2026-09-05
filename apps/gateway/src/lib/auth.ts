import type { BotContext } from './bot-context.js';

export type NextFunction = () => Promise<void>;

/**
 * Phase 1 has exactly one admin — the owner, identified by `OWNER_TELEGRAM_ID` (env var).
 * No `admin-store`/roles until Phase 2 (docs/PLAN.md §9) — deny everyone else by default (§8).
 */
export function requireOwner(ownerTelegramId: number) {
  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    if (ctx.from?.id !== ownerTelegramId) {
      await ctx.reply('Not authorized.');
      return;
    }
    await next();
  };
}
