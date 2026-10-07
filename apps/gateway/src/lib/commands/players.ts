import type { StatusPlayer } from '@cod2admin/rcon-client';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { describeIpShort, NO_COUNTRY_LOOKUP, type CountryLookup } from '../geoip.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';
import { describeVpnShort, joinIpLabels, NO_VPN_LOOKUP, type VpnLookup } from '../vpn-ranges.js';

function formatPlayerLine(player: StatusPlayer, geoip: CountryLookup, vpn: VpnLookup): string {
  const ip = player.ip ?? 'unknown';
  const labels = joinIpLabels(describeIpShort(geoip, player.ip), describeVpnShort(vpn, player.ip));
  return `#${player.num} ${player.name} — score ${player.score}, ping ${player.ping}, ip ${ip}${labels ? ` ${labels}` : ''}`;
}

/**
 * Formats the `/players` list — detailed `rcon status` table, includes IPs, their country and a
 * VPN/proxy/Tor flag (docs/PLAN.md §6).
 */
export function formatPlayersMessage(
  players: StatusPlayer[],
  geoip: CountryLookup = NO_COUNTRY_LOOKUP,
  vpn: VpnLookup = NO_VPN_LOOKUP,
): string {
  if (players.length === 0) {
    return 'No players connected.';
  }
  return players.map((player) => formatPlayerLine(player, geoip, vpn)).join('\n');
}

/** `/players [--server <alias>]` (docs/PLAN.md §6). */
export async function playersCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }
  const { players } = await server.rcon.status();
  await ctx.reply(formatPlayersMessage(players, deps.geoip, deps.vpn));
}
