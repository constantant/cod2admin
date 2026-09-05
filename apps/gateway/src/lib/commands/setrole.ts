import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

const ASSIGNABLE_ROLES = ['admin', 'moderator'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

function isAssignableRole(value: string): value is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

/** `/setrole <reply-or-telegram-id> <role>` (docs/PLAN.md §4). */
export async function setRoleCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const tokens = matchText(ctx).split(/\s+/).filter(Boolean);
  const targetId = ctx.replyToUserId ?? Number.parseInt(tokens[0] ?? '', 10);
  const role = ctx.replyToUserId !== undefined ? tokens[0] : tokens[1];

  if (Number.isNaN(targetId) || !role || !isAssignableRole(role)) {
    await ctx.reply('Usage: /setrole <telegram-id-or-reply> <admin|moderator>');
    return;
  }

  if (role === 'admin' && ctx.admin?.role !== 'owner') {
    await ctx.reply('Only the owner can grant the admin role.');
    return;
  }

  await deps.adminStore.setRole(targetId, role);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'setrole',
    target: String(targetId),
    reason: role,
    source: 'telegram_command',
  });
  await ctx.reply(`Set ${targetId}'s role to ${role}.`);
}
