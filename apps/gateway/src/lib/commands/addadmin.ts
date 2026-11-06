import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

/**
 * Resolves the target from a reply (preferred) or a raw numeric Telegram ID — the Bot API has no
 * reliable way to resolve an arbitrary `@username` to an ID without that user having started the
 * bot (docs/PLAN.md §4 says "reply-or-@user"; this is the closest honest equivalent).
 */
function parseTarget(ctx: BotContext): number | undefined {
  if (ctx.replyToUserId !== undefined) {
    return ctx.replyToUserId;
  }
  const targetId = Number.parseInt(matchText(ctx).split(/\s+/)[0] ?? '', 10);
  return Number.isNaN(targetId) ? undefined : targetId;
}

/** `/addadmin <reply-or-telegram-id>` — adds them with no permissions. `/permit` sets those. */
export async function addAdminCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  const targetId = parseTarget(ctx);
  if (targetId === undefined) {
    await ctx.reply('Usage: /addadmin <telegram-id-or-reply>');
    return;
  }

  if (await deps.adminStore.getAdmin(targetId)) {
    await ctx.reply(
      `${targetId} is already staff. Change their permissions with /permit.`,
    );
    return;
  }

  await deps.adminStore.addAdmin(targetId, [], ctx.admin!.telegramId);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'addadmin',
    target: String(targetId),
    source: 'telegram_command',
  });
  await ctx.reply(`Added ${targetId}.`);
}
