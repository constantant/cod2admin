import type { RconClient } from '@cod2admin/rcon-client';
import { matchText, type BotContext } from '../bot-context.js';
import { broadcastModerationAction } from '../broadcast.js';
import { sanitizeRconArg } from '../sanitize.js';

/** `/kick <client id or name>` — direct command, same rcon call as the report-card button (§6). */
export async function kickCommand(ctx: BotContext, rcon: RconClient): Promise<void> {
  const target = sanitizeRconArg(matchText(ctx));
  if (!target) {
    await ctx.reply('Usage: /kick <client id or name>');
    return;
  }
  await rcon.kick(target);
  await broadcastModerationAction(rcon, target, 'kicked');
  await ctx.reply(`Kicked ${target}.`);
}
