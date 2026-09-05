import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';
import { sanitizeRconArg } from '../sanitize.js';

/** `/map <name> [--server <alias>]` — map control, admin-role-gated (docs/PLAN.md §6). */
export async function mapCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias, rest } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  const mapName = sanitizeRconArg(rest);
  if (!mapName) {
    await ctx.reply('Usage: /map <name> [--server <alias>]');
    return;
  }

  await server.rcon.map(mapName);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'map',
    target: mapName,
    serverAlias: server.alias,
    source: 'telegram_command',
  });
  await ctx.reply(`Changing map to ${mapName}...`);
}
