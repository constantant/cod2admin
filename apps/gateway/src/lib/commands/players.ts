import type { StatusPlayer } from '@cod2admin/rcon-client';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';

function formatPlayerLine(player: StatusPlayer): string {
  const ip = player.ip ?? 'unknown';
  return `#${player.num} ${player.name} — score ${player.score}, ping ${player.ping}, ip ${ip}`;
}

/** Formats the `/players` list — detailed `rcon status` table, includes IPs (docs/PLAN.md §6). */
export function formatPlayersMessage(players: StatusPlayer[]): string {
  if (players.length === 0) {
    return 'No players connected.';
  }
  return players.map(formatPlayerLine).join('\n');
}

/** `/players [--server <alias>]` (docs/PLAN.md §6). */
export async function playersCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }
  const { players } = await server.rcon.status();
  await ctx.reply(formatPlayersMessage(players));
}
