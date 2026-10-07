import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';
import { sanitizeRconArg } from '../sanitize.js';
import { CUSTOM_MAP_WARNING, STOCK_MAPS } from './maps.js';

const MAX_SUGGESTIONS = 5;

/**
 * `/map <name> [mode] [--server <alias>]` — map control, admin-role-gated (docs/PLAN.md §6). The name is
 * checked against the maps installed on the server (`dir maps/mp d3dbsp`), case-insensitively, so
 * a typo gets suggestions instead of a failed map change. If the server can't list its maps, the
 * name is sent as typed, as before. A mode (`ctf`, `tdm`, ...) switches the game mode too; it must
 * be one the server has (`dir maps/mp/gametypes gsc`). Without one the map loads in the current mode.
 */
export async function mapCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  const { alias: serverAlias, rest } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  const [typed, typedGametype, ...extra] = sanitizeRconArg(rest)
    .split(/\s+/)
    .filter(Boolean);
  if (!typed || extra.length > 0) {
    await ctx.reply(
      'Usage: /map <name> [mode] [--server <alias>], e.g. /map mp_toujane ctf',
    );
    return;
  }

  let gametype: string | undefined;
  if (typedGametype) {
    const gametypes = await server.rcon
      .getGametypes()
      .catch(() => [] as string[]);
    gametype =
      gametypes.length > 0
        ? gametypes.find(
            (name) => name.toLowerCase() === typedGametype.toLowerCase(),
          )
        : /^[A-Za-z0-9_-]{1,32}$/.test(typedGametype)
          ? typedGametype
          : undefined;
    if (!gametype) {
      await ctx.reply(
        `There's no game mode "${typedGametype}" on ${server.alias}.` +
          (gametypes.length > 0 ? ` It has: ${gametypes.join(', ')}.` : ''),
      );
      return;
    }
  }

  const installed = await server.rcon
    .getInstalledMaps()
    .catch((error: unknown) => {
      console.error('Listing installed maps failed:', error);
      return [] as string[];
    });
  let mapName = typed;
  if (installed.length > 0) {
    const exact = installed.find(
      (name) => name.toLowerCase() === typed.toLowerCase(),
    );
    if (!exact) {
      const needle = typed.toLowerCase().replace(/^mp_/, '');
      const suggestions = installed
        .filter((name) => name.toLowerCase().includes(needle))
        .slice(0, MAX_SUGGESTIONS);
      await ctx.reply(
        `There's no map "${typed}" on ${server.alias}.` +
          (suggestions.length > 0
            ? ` Did you mean: ${suggestions.join(', ')}?`
            : '') +
          ' /maps lists every installed map.',
      );
      return;
    }
    mapName = exact;
  }

  await server.rcon.map(mapName, gametype);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'map',
    target: gametype ? `${mapName} (${gametype})` : mapName,
    serverAlias: server.alias,
    source: 'telegram_command',
    detailJson: gametype ? { map: mapName, gametype } : undefined,
  });
  const warning =
    installed.length > 0 && !STOCK_MAPS.has(mapName)
      ? ` Note: it's ${CUSTOM_MAP_WARNING}.`
      : '';
  await ctx.reply(
    `Changing map to ${mapName}${gametype ? ` (${gametype})` : ''}...${warning}`,
  );
}
