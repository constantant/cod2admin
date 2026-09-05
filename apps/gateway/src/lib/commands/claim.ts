import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

/**
 * `/claim <secret>` (docs/PLAN.md §4) — the alternative to `OWNER_TELEGRAM_ID` for bootstrapping
 * the owner. No role gate (must work before any admin exists). Race-safe: `claimOwner` is backed
 * by a DB-level unique constraint, not a check-then-insert.
 */
export async function claimCommand(ctx: BotContext, deps: GatewayDeps, claimSecret: string): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) {
    await ctx.reply('Could not identify you.');
    return;
  }

  const providedSecret = matchText(ctx);
  if (!providedSecret) {
    await ctx.reply('Usage: /claim <secret>');
    return;
  }
  if (providedSecret !== claimSecret) {
    await ctx.reply('Invalid secret.');
    return;
  }

  const result = await deps.adminStore.claimOwner(telegramId);
  await ctx.reply(result === 'already-claimed' ? 'Owner already set.' : 'You are now the owner.');
}
