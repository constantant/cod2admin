import { stripColorCodes, type CvarMap } from '@cod2admin/rcon-client';
import { sanitizeRconArg } from './sanitize.js';

/** A status row newer than this is reused. Older than this may cost one `status`. */
const FRESH_STATUS_MS = 10_000;
/** One identity RCON (`status` or `dumpuser`) per server per this interval. */
const IDENTITY_RCON_INTERVAL_MS = 1_000;

export interface IdentityPlayer {
  guid?: string;
  ip?: string;
  name: string;
  /** `status` num. Never sent as `dumpuser`'s argument. */
  slot: number;
}

export interface IdentityResolveInput {
  serverAlias: string;
  player: IdentityPlayer;
  /**
   * When `player` was read from `status`. Within the last 10 seconds the
   * helper does not call `status` itself. Omit it when the age is unknown.
   */
  statusFetchedAt?: number;
  /** Already-fetched `dumpuser` map. When set, no identity RCON is sent. */
  dumpuser?: CvarMap;
}

export interface IdentityResolution {
  key: string | null;
  /** Row the key was built from. A status refresh replaces the caller's row. */
  player: IdentityPlayer;
  /**
   * Pass this back as `statusFetchedAt` on the next resolve. Echoes the
   * caller's time when that row was fresh, otherwise the time the slot was found.
   */
  statusFetchedAt?: number;
  /**
   * True when this call did not use a `dumpuser` result. The key stays at
   * GUID or IP. A map the caller already passed is not a skip.
   */
  dumpuserSkipped: boolean;
}

interface StatusLikePlayer {
  guid?: string;
  ip?: string;
  name: string;
  num?: number;
  slot?: number;
}

export interface PlayerIdentityResolverDeps {
  /** Defaults to `Date.now`. Tests pass a fake clock. Does not start a timer. */
  now?: () => number;
  dumpuser?: (serverAlias: string, strippedName: string) => Promise<CvarMap>;
  status?: (serverAlias: string) => Promise<{
    players: readonly StatusLikePlayer[];
  }>;
}

/**
 * Best stable id for one player. `cl_hwid` `0` and guid `0` are never keys.
 * A missing or failed `dumpuser` leaves the key at GUID, else IP with no port.
 */
export function playerIdentityKey(
  player: Pick<IdentityPlayer, 'guid' | 'ip'>,
  dumpuser?: CvarMap,
): string | null {
  const hwid = signedHwid(dumpuser?.['cl_hwid']);
  if (hwid !== null) {
    return `hwid:${hwid}`;
  }
  const guid = presentId(player.guid);
  if (guid !== null) {
    return `guid:${guid}`;
  }
  const ip = ipWithoutPort(player.ip);
  if (ip !== null) {
    return `ip:${ip}`;
  }
  return null;
}

function presentId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '0') {
    return null;
  }
  return trimmed;
}

/** CoD2x prints `cl_hwid` as a signed int. Zero means the client sent none. */
function signedHwid(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed === 0) {
    return null;
  }
  return String(parsed);
}

function ipWithoutPort(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon > 0 && /^-?\d+$/.test(trimmed.slice(colon + 1))) {
    const host = trimmed.slice(0, colon);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      return host;
    }
  }
  return trimmed;
}

function isFresh(fetchedAt: number | undefined, at: number): boolean {
  return (
    fetchedAt !== undefined &&
    at >= fetchedAt &&
    at - fetchedAt <= FRESH_STATUS_MS
  );
}

function toIdentityPlayer(player: StatusLikePlayer): IdentityPlayer | null {
  const slot = player.slot ?? player.num;
  if (slot === undefined) {
    return null;
  }
  return {
    guid: player.guid,
    ip: player.ip,
    name: player.name,
    slot,
  };
}

/**
 * Resolves one player when the caller asks. No timer and no RCON until
 * `resolve`. A fresh status row (the ban sweep's, from the last 10 seconds)
 * is used as-is. A stale row costs one `status` and does not also `dumpuser`
 * in that same second. `dumpuser` is refused while the previous identity
 * command for that server was under a second ago.
 */
export function createPlayerIdentityResolver(
  deps: PlayerIdentityResolverDeps = {},
) {
  const now = deps.now ?? (() => Date.now());
  const lastRconAt = new Map<string, number>();

  function budgetOpen(serverAlias: string, at: number): boolean {
    const last = lastRconAt.get(serverAlias);
    return last === undefined || at - last >= IDENTITY_RCON_INTERVAL_MS;
  }

  function spend(serverAlias: string, at: number): void {
    lastRconAt.set(serverAlias, at);
  }

  function fromRow(
    player: IdentityPlayer,
    statusFetchedAt: number | undefined,
    dumpuserSkipped: boolean,
    dumpuser?: CvarMap,
  ): IdentityResolution {
    return {
      key: playerIdentityKey(player, dumpuser),
      player,
      statusFetchedAt,
      dumpuserSkipped,
    };
  }

  return {
    async resolve(input: IdentityResolveInput): Promise<IdentityResolution> {
      const at = now();
      if (input.dumpuser !== undefined) {
        return fromRow(
          input.player,
          input.statusFetchedAt,
          false,
          input.dumpuser,
        );
      }

      let player = input.player;
      let statusFetchedAt = input.statusFetchedAt;

      // A stale slot can belong to someone else. Refreshing it spends this
      // second's identity command, so dumpuser waits for the next call.
      if (!isFresh(statusFetchedAt, at) && deps.status) {
        if (!budgetOpen(input.serverAlias, at)) {
          return fromRow(player, statusFetchedAt, true);
        }
        spend(input.serverAlias, at);
        try {
          const status = await deps.status(input.serverAlias);
          const found = status.players
            .map(toIdentityPlayer)
            .filter((row): row is IdentityPlayer => row !== null)
            .find((row) => row.slot === input.player.slot);
          if (found) {
            player = found;
            statusFetchedAt = at;
          }
        } catch {
          // Status was still the identity command for this second.
        }
        return fromRow(player, statusFetchedAt, true);
      }

      if (!deps.dumpuser) {
        return fromRow(player, statusFetchedAt, true);
      }

      // Callers strip before dumpuser. Strip here too so a colored status
      // name cannot miss; RconClient strips again and does the quoting.
      const name = sanitizeRconArg(stripColorCodes(player.name));
      if (name === '' || !budgetOpen(input.serverAlias, at)) {
        return fromRow(player, statusFetchedAt, true);
      }

      spend(input.serverAlias, at);
      try {
        const userinfo = await deps.dumpuser(input.serverAlias, name);
        return fromRow(player, statusFetchedAt, false, userinfo);
      } catch {
        return fromRow(player, statusFetchedAt, false);
      }
    },
  };
}
