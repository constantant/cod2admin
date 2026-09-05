import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

const ASSIGNABLE_ROLES = ['admin', 'moderator'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

function isAssignableRole(value: string): value is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

/**
 * Resolves the target from a reply (preferred) or a raw numeric Telegram ID — the Bot API has no
 * reliable way to resolve an arbitrary `@username` to an ID without that user having started the
 * bot (docs/PLAN.md §4 says "reply-or-@user"; this is the closest honest equivalent).
 */
function parseTarget(ctx: BotContext): { targetId: number; roleToken: string | undefined } | undefined {
  const tokens = matchText(ctx).split(/\s+/).filter(Boolean);
  if (ctx.replyToUserId !== undefined) {
    return { targetId: ctx.replyToUserId, roleToken: tokens[0] };
  }
  const targetId = Number.parseInt(tokens[0] ?? '', 10);
  if (Number.isNaN(targetId)) {
    return undefined;
  }
  return { targetId, roleToken: tokens[1] };
}

/** `/addadmin <reply-or-telegram-id> <role>` (docs/PLAN.md §4). */
export async function addAdminCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const parsed = parseTarget(ctx);
  const role = parsed?.roleToken;
  if (!parsed || !role || !isAssignableRole(role)) {
    await ctx.reply('Usage: /addadmin <telegram-id-or-reply> <admin|moderator>');
    return;
  }

  // Only the owner may grant admin — an admin can only add moderators (least-privilege default).
  if (role === 'admin' && ctx.admin?.role !== 'owner') {
    await ctx.reply('Only the owner can grant the admin role. You can add moderators.');
    return;
  }

  await deps.adminStore.addAdmin(parsed.targetId, role, ctx.admin!.telegramId);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'addadmin',
    target: String(parsed.targetId),
    reason: role,
    source: 'telegram_command',
  });
  await ctx.reply(`Added ${parsed.targetId} as ${role}.`);
}
