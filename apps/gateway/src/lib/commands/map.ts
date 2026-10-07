import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';
import { sanitizeRconArg } from '../sanitize.js';
import { CUSTOM_MAP_WARNING, STOCK_MAPS } from './maps.js';

const MAX_SUGGESTIONS = 5;

/**
 * `/map <name> [--server <alias>]` — map control, admin-role-gated (docs/PLAN.md §6). The name is
 * checked against the maps installed on the server (`dir maps/mp d3dbsp`), case-insensitively, so
 * a typo gets suggestions instead of a failed map change. If the server can't list its maps, the
 * name is sent as typed, as before.
 */
export async function mapCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias, rest } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  const typed = sanitizeRconArg(rest);
  if (!typed) {
    await ctx.reply('Usage: /map <name> [--server <alias>]');
    return;
  }

  const installed = await server.rcon.getInstalledMaps().catch((error: unknown) => {
    console.error('Listing installed maps failed:', error);
    return [] as string[];
  });
  let mapName = typed;
  if (installed.length > 0) {
    const exact = installed.find((name) => name.toLowerCase() === typed.toLowerCase());
    if (!exact) {
      const needle = typed.toLowerCase().replace(/^mp_/, '');
      const suggestions = installed.filter((name) => name.toLowerCase().includes(needle)).slice(0, MAX_SUGGESTIONS);
      await ctx.reply(
        `There's no map "${typed}" on ${server.alias}.` +
          (suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '') +
          ' /maps lists every installed map.',
      );
      return;
    }
    mapName = exact;
  }

  await server.rcon.map(mapName);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'map',
    target: mapName,
    serverAlias: server.alias,
    source: 'telegram_command',
  });
  const warning = installed.length > 0 && !STOCK_MAPS.has(mapName) ? ` Note: it's ${CUSTOM_MAP_WARNING}.` : '';
  await ctx.reply(`Changing map to ${mapName}...${warning}`);
}
