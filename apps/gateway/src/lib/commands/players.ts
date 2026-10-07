import type { StatusPlayer } from '@cod2admin/rcon-client';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import {
  describeIpShort,
  describeProviderShort,
  joinCountryAndProvider,
  NO_COUNTRY_LOOKUP,
  NO_PROVIDER_LOOKUP,
  type CountryLookup,
  type ProviderLookup,
} from '../geoip.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';
import { describeVpnShort, joinIpLabels, NO_VPN_LOOKUP, type VpnLookup } from '../vpn-ranges.js';

/** What `/players` shows next to each IP. Each lookup defaults to "show nothing". */
export interface PlayerIpLookups {
  geoip?: CountryLookup;
  provider?: ProviderLookup;
  vpn?: VpnLookup;
}

function formatPlayerLine(player: StatusPlayer, lookups: Required<PlayerIpLookups>): string {
  const ip = player.ip ?? 'unknown';
  const labels = joinIpLabels(
    joinCountryAndProvider(describeIpShort(lookups.geoip, player.ip), describeProviderShort(lookups.provider, player.ip)),
    describeVpnShort(lookups.vpn, player.ip),
  );
  return `#${player.num} ${player.name} — score ${player.score}, ping ${player.ping}, ip ${ip}${labels ? ` ${labels}` : ''}`;
}

/**
 * Formats the `/players` list — detailed `rcon status` table, includes IPs, their country, provider
 * and a VPN/proxy/Tor flag (docs/PLAN.md §6).
 */
export function formatPlayersMessage(players: StatusPlayer[], lookups: PlayerIpLookups = {}): string {
  if (players.length === 0) {
    return 'No players connected.';
  }
  const resolved = {
    geoip: lookups.geoip ?? NO_COUNTRY_LOOKUP,
    provider: lookups.provider ?? NO_PROVIDER_LOOKUP,
    vpn: lookups.vpn ?? NO_VPN_LOOKUP,
  };
  return players.map((player) => formatPlayerLine(player, resolved)).join('\n');
}

/** `/players [--server <alias>]` (docs/PLAN.md §6). */
export async function playersCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }
  const { players } = await server.rcon.status();
  await ctx.reply(formatPlayersMessage(players, deps));
}
