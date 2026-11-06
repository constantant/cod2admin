import {
  PermissionError,
  resolvePermissionGrant,
} from '@cod2admin/admin-store';
import { cannotManageReason, mayManageAdmin } from '../admin-rules.js';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

/**
 * Reply: the whole match is the permission list. Otherwise the first token is the Telegram id
 * and the rest is the list. Commas and whitespace both separate ids. No ids means clear.
 */
function parsePermit(
  ctx: BotContext,
): { targetId: number; requested: string[] } | undefined {
  const text = matchText(ctx);
  if (ctx.replyToUserId !== undefined) {
    return {
      targetId: ctx.replyToUserId,
      requested: text.split(/[\s,]+/).filter(Boolean),
    };
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  const targetId = Number.parseInt(tokens[0] ?? '', 10);
  if (Number.isNaN(targetId)) {
    return undefined;
  }
  return {
    targetId,
    requested: tokens
      .slice(1)
      .join(' ')
      .split(/[\s,]+/)
      .filter(Boolean),
  };
}

/** `/permit <reply-or-telegram-id> kick,tempban,mute` — replaces their permissions. */
export async function permitCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  const parsed = parsePermit(ctx);
  if (!parsed) {
    await ctx.reply(
      'Usage: /permit <telegram-id-or-reply> [kick, tempban, ...]',
    );
    return;
  }

  const target = await deps.adminStore.getAdmin(parsed.targetId);
  if (!target) {
    await ctx.reply(
      `${parsed.targetId} isn't an admin. Add them with /addadmin.`,
    );
    return;
  }
  if (!mayManageAdmin(ctx.admin!, target)) {
    await ctx.reply(cannotManageReason(ctx.admin!, target));
    return;
  }

  let permissions;
  try {
    permissions = resolvePermissionGrant({
      actorIsOwner: ctx.admin!.isOwner,
      actorPermissions: ctx.admin!.permissions,
      targetPermissions: target.permissions,
      requested: parsed.requested,
    });
  } catch (error) {
    if (error instanceof PermissionError) {
      await ctx.reply(error.message);
      return;
    }
    throw error;
  }

  await deps.adminStore.setPermissions(parsed.targetId, permissions);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'permit',
    target: String(parsed.targetId),
    reason: permissions.join(','),
    source: 'telegram_command',
  });
  const listed = permissions.join(', ');
  await ctx.reply(
    listed
      ? `Set ${parsed.targetId}'s permissions to ${listed}.`
      : `Cleared ${parsed.targetId}'s permissions.`,
  );
}
