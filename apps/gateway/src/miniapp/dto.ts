import type { Ban, BanIp, Mute } from '@cod2admin/ban-store';
import type { StatusPlayer } from '@cod2admin/rcon-client';
import type { GatewayDeps } from '../lib/deps.js';
import { describeProviderLong, formatCountryLong } from '../lib/geoip.js';
import { formatTelegramUser } from '../lib/telegram-user.js';
import { describeVpnShort } from '../lib/vpn-ranges.js';
import type { BanDto, MuteDto, PlayerDto } from './api-types.js';

type IpLookups = Pick<GatewayDeps, 'geoip' | 'provider' | 'vpn'> & {
  knownPlayers?: Pick<GatewayDeps['knownPlayers'], 'verdict'>;
};

/** What the bot knows about an IP: country/city, provider and VPN flag — each only when known. */
function describeIp(
  ip: string | undefined,
  lookups: IpLookups,
): Pick<PlayerDto, 'countryCode' | 'location' | 'provider' | 'vpn'> {
  if (!ip) {
    return {};
  }
  const country = lookups.geoip.lookup(ip);
  const provider = describeProviderLong(lookups.provider, ip);
  const vpn = describeVpnShort(lookups.vpn, ip);
  return {
    ...(country
      ? {
          countryCode: country.code,
          location: formatCountryLong(country).replace(/^\S+\s/, ''),
        }
      : {}),
    ...(provider ? { provider } : {}),
    ...(vpn ? { vpn } : {}),
  };
}

export function toPlayerDto(
  player: StatusPlayer,
  lookups: IpLookups,
): PlayerDto {
  const verdict = lookups.knownPlayers?.verdict(player);
  return {
    num: player.num,
    name: player.name,
    score: player.score,
    ping: player.ping,
    guid: player.guid && player.guid !== '0' ? player.guid : null,
    ip: player.ip ?? null,
    ...describeIp(player.ip, lookups),
    ...(verdict === 'known' || verdict === 'impostor' ? { known: verdict } : {}),
  };
}

/** `@nick`/first name of whoever issued a ban, by Telegram ID — see `formatTelegramUser`. */
export type AdminNames = Map<
  number,
  { username: string | null; firstName: string | null }
>;

function bannedBy(telegramId: number, names: AdminNames): string {
  const known = names.get(telegramId);
  return formatTelegramUser(telegramId, known?.username, known?.firstName);
}

export function toMuteDto(mute: Mute, names: AdminNames): MuteDto {
  return {
    id: mute.id,
    server: mute.serverAlias,
    name: mute.name,
    guid: mute.guid,
    ip: mute.ip,
    reason: mute.reason,
    mutedBy: bannedBy(mute.mutedBy, names),
    mutedAt: mute.mutedAt.toISOString(),
    expiresAt: mute.expiresAt?.toISOString() ?? null,
  };
}

export function toGuidBanDto(ban: Ban, names: AdminNames): BanDto {
  return {
    kind: 'guid',
    id: ban.id,
    server: ban.serverAlias,
    guid: ban.guid,
    name: ban.name,
    ip: null,
    reason: ban.reason,
    bannedBy: bannedBy(ban.bannedBy, names),
    bannedAt: ban.bannedAt.toISOString(),
    expiresAt: ban.expiresAt?.toISOString() ?? null,
    liftedAt: ban.unbannedAt?.toISOString() ?? null,
  };
}

export function toIpBanDto(
  ban: BanIp,
  names: AdminNames,
  lookups: IpLookups,
): BanDto {
  const { countryCode, location } = describeIp(ban.ip, lookups);
  return {
    kind: 'ip',
    id: ban.id,
    server: ban.serverAlias,
    guid: null,
    name: ban.name,
    ip: ban.ip,
    ...(countryCode ? { countryCode } : {}),
    ...(location ? { location } : {}),
    reason: ban.reason,
    bannedBy: bannedBy(ban.bannedBy, names),
    bannedAt: ban.bannedAt.toISOString(),
    expiresAt: ban.expiresAt?.toISOString() ?? null,
    liftedAt: ban.unbannedAt?.toISOString() ?? null,
  };
}
