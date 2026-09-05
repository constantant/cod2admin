import type { RconClient } from '@cod2admin/rcon-client';
import { matchText, type BotContext } from '../bot-context.js';
import { sanitizeRconArg } from '../sanitize.js';

/** `/unban <guid>` (docs/PLAN.md §6). */
export async function unbanCommand(ctx: BotContext, rcon: RconClient): Promise<void> {
  const guid = sanitizeRconArg(matchText(ctx));
  if (!guid) {
    await ctx.reply('Usage: /unban <guid>');
    return;
  }
  await rcon.unbanUser(guid);
  await ctx.reply(`Unbanned GUID ${guid}.`);
}
