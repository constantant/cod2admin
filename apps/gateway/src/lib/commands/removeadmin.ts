import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

/** `/removeadmin <reply-or-telegram-id>` (docs/PLAN.md §4). */
export async function removeAdminCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const targetId = ctx.replyToUserId ?? Number.parseInt(matchText(ctx).split(/\s+/)[0] ?? '', 10);
  if (Number.isNaN(targetId)) {
    await ctx.reply('Usage: /removeadmin <telegram-id-or-reply>');
    return;
  }

  await deps.adminStore.removeAdmin(targetId);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'removeadmin',
    target: String(targetId),
    source: 'telegram_command',
  });
  await ctx.reply(`Removed ${targetId} from admins.`);
}
