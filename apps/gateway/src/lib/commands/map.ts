import type { RconClient } from '@cod2admin/rcon-client';
import { matchText, type BotContext } from '../bot-context.js';
import { sanitizeRconArg } from '../sanitize.js';

/** `/map <name>` — map control, admin-role-gated (docs/PLAN.md §6). */
export async function mapCommand(ctx: BotContext, rcon: RconClient): Promise<void> {
  const mapName = sanitizeRconArg(matchText(ctx));
  if (!mapName) {
    await ctx.reply('Usage: /map <name>');
    return;
  }
  await rcon.map(mapName);
  await ctx.reply(`Changing map to ${mapName}...`);
}
