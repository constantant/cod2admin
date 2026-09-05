import type { RconClient } from '@cod2admin/rcon-client';
import { matchText, type BotContext } from '../bot-context.js';
import { broadcastModerationAction } from '../broadcast.js';
import { sanitizeRconArg } from '../sanitize.js';

/**
 * `/ban <client id> [reason]` — takes a currently-connected client's slot number, matching
 * `RconClient#banUser`'s signature. No `ban-store` yet (Phase 2, docs/PLAN.md §9), so the
 * reason is only used in the moderation broadcast (§6), not persisted.
 */
export async function banCommand(ctx: BotContext, rcon: RconClient): Promise<void> {
  const [idToken, ...reasonParts] = matchText(ctx).split(/\s+/).filter(Boolean);
  const clientId = idToken === undefined ? NaN : Number.parseInt(idToken, 10);
  if (idToken === undefined || Number.isNaN(clientId)) {
    await ctx.reply('Usage: /ban <client id> [reason]');
    return;
  }
  const reason = sanitizeRconArg(reasonParts.join(' '));

  await rcon.banUser(clientId);

  const label = reason ? `client ${clientId} (${reason})` : `client ${clientId}`;
  await broadcastModerationAction(rcon, label, 'banned');
  await ctx.reply(`Banned client ${clientId}${reason ? ` for: ${reason}` : ''}.`);
}
