import { stripColorCodes, type StatusPlayer } from '@cod2admin/rcon-client';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import {
  describeIpLong,
  describeIpShort,
  describeProviderShort,
  flagEmoji,
  joinCountryAndProvider,
  NO_COUNTRY_LOOKUP,
  NO_PROVIDER_LOOKUP,
  type CountryLookup,
  type ProviderLookup,
} from '../geoip.js';
import { markdownTable, replyWithReport, reportDocument, reportFileName, type LongReply } from '../long-reply.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';
import { describeVpnLong, describeVpnShort, joinIpLabels, NO_VPN_LOOKUP, type VpnLookup } from '../vpn-ranges.js';

/** What `/players` shows next to each IP. Each lookup defaults to "show nothing". */
export interface PlayerIpLookups {
  geoip?: CountryLookup;
  provider?: ProviderLookup;
  vpn?: VpnLookup;
}

function resolveLookups(lookups: PlayerIpLookups): Required<PlayerIpLookups> {
  return {
    geoip: lookups.geoip ?? NO_COUNTRY_LOOKUP,
    provider: lookups.provider ?? NO_PROVIDER_LOOKUP,
    vpn: lookups.vpn ?? NO_VPN_LOOKUP,
  };
}

/**
 * The name as players see it in-game — `status` keeps the `^N` colour codes, including the doubled
 * `^^11` form some players use (seen live on CTF RUSSIA 2026-10-07), which a single strip pass
 * turns into `^1` instead of removing.
 */
export function displayName(player: StatusPlayer): string {
  return stripColorCodes(player.name.replace(/\^\^(\d)\1/g, '')).trim() || `client ${player.num}`;
}

function formatPlayerLine(player: StatusPlayer, lookups: Required<PlayerIpLookups>): string {
  const ip = player.ip ?? 'unknown';
  const labels = joinIpLabels(
    joinCountryAndProvider(describeIpShort(lookups.geoip, player.ip), describeProviderShort(lookups.provider, player.ip)),
    describeVpnShort(lookups.vpn, player.ip),
  );
  return `#${player.num} ${displayName(player)} — score ${player.score}, ping ${player.ping}, ip ${ip}${labels ? ` ${labels}` : ''}`;
}

/**
 * Formats the `/players` list — detailed `rcon status` table, includes IPs, their country, provider
 * and a VPN/proxy/Tor flag (docs/PLAN.md §6).
 */
export function formatPlayersMessage(players: StatusPlayer[], lookups: PlayerIpLookups = {}): string {
  if (players.length === 0) {
    return 'No players connected.';
  }
  const resolved = resolveLookups(lookups);
  return players.map((player) => formatPlayerLine(player, resolved)).join('\n');
}

export interface PlayersContext {
  serverAlias: string;
  mapName?: string;
}

function header(players: StatusPlayer[], context: PlayersContext): string {
  const count = `${players.length} player${players.length === 1 ? '' : 's'}`;
  return [count, context.serverAlias, context.mapName].filter(Boolean).join(' · ');
}

/**
 * The short `/players` for a full server: a header, players per country, how many are flagged
 * as VPN, and one compact line per player — everything else is in the attached report.
 */
export function formatPlayersSummary(players: StatusPlayer[], lookups: PlayerIpLookups, context: PlayersContext): string {
  const resolved = resolveLookups(lookups);
  const countries = new Map<string, number>();
  let flagged = 0;
  const lines = players.map((player) => {
    const code = player.ip ? resolved.geoip.lookup(player.ip)?.code : undefined;
    if (code) {
      countries.set(code, (countries.get(code) ?? 0) + 1);
    }
    const vpn = player.ip ? resolved.vpn.lookup(player.ip) : undefined;
    if (vpn) {
      flagged++;
    }
    const flag = code ? (code === 'LAN' ? 'LAN' : flagEmoji(code)) : '';
    return [`#${player.num}`, displayName(player), flag, vpn ? '🛡' : ''].filter(Boolean).join(' ');
  });

  const summary = [header(players, context)];
  if (countries.size > 0) {
    summary.push(
      [...countries]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([code, count]) => `${code === 'LAN' ? 'LAN' : flagEmoji(code)} ${count}`)
        .join('  '),
    );
  }
  if (flagged > 0) {
    summary.push(`🛡 ${flagged} on VPN/proxy/Tor`);
  }
  summary.push('', ...lines, '', 'Full details (IP, city, provider, GUID) in the attached file.');
  return summary.join('\n');
}

/** The attached `/players` report: one table row per player with everything the bot knows. */
export function formatPlayersReport(
  players: StatusPlayer[],
  lookups: PlayerIpLookups,
  context: PlayersContext,
  now: Date,
): string {
  const resolved = resolveLookups(lookups);
  const rows = players.map((player) => {
    const ip = player.ip;
    const asn = ip ? resolved.provider.asn(ip) : undefined;
    const provider = ip ? resolved.provider.lookup(ip) : undefined;
    return [
      player.num,
      displayName(player),
      player.score,
      player.ping,
      player.guid && player.guid !== '0' ? player.guid : '0',
      ip ?? 'unknown',
      ip ? describeIpLong(resolved.geoip, ip) : undefined,
      provider ? (asn ? `${provider} (AS${asn})` : provider) : undefined,
      ip ? describeVpnLong(resolved.vpn, ip) : undefined,
    ];
  });
  return reportDocument({
    title: `Players — ${context.serverAlias}`,
    meta: [`Server: ${context.serverAlias}`, ...(context.mapName ? [`Map: ${context.mapName}`] : []), `Players: ${players.length}`],
    body: markdownTable(['#', 'Name', 'Score', 'Ping', 'GUID', 'IP', 'Location', 'Provider', 'VPN'], rows),
    now,
    credits: true,
  });
}

export function buildPlayersReply(
  players: StatusPlayer[],
  lookups: PlayerIpLookups,
  context: PlayersContext,
  now: Date = new Date(),
): LongReply {
  return {
    full: formatPlayersMessage(players, lookups),
    summary: formatPlayersSummary(players, lookups, context),
    markdown: formatPlayersReport(players, lookups, context, now),
    fileName: reportFileName('players', context.serverAlias, now),
  };
}

/** `/players [--server <alias>]` (docs/PLAN.md §6). */
export async function playersCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }
  const { players, mapName } = await server.rcon.status();
  await replyWithReport(ctx, buildPlayersReply(players, deps, { serverAlias: server.alias, mapName }));
}
