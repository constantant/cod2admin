import {
  DumpuserReplyError,
  stripColorCodes,
  type CvarMap,
  type StatusPlayer,
} from '@cod2admin/rcon-client';
import { sanitizeRconArg } from './sanitize.js';

/** A status row newer than this is reused. Older than this may cost one `status`. */
const FRESH_STATUS_MS = 10_000;
/** One identity RCON (`status` or `dumpuser`) per server per this interval. */
const IDENTITY_RCON_INTERVAL_MS = 1_000;

export interface IdentityResolveInput {
  serverAlias: string;
  player: StatusPlayer;
  /**
   * When `player` was read from `status`. Within the last 10 seconds the
   * helper does not call `status` itself. Omit it when the age is unknown.
   */
  statusFetchedAt?: number;
}

export interface IdentityResolution {
  key: string | null;
  /** Row the key was built from. A status refresh replaces the caller's row. */
  player: StatusPlayer;
  /**
   * Pass this back as `statusFetchedAt` on the next resolve. Echoes the
   * caller's time when that row was fresh, otherwise the time the player was found.
   */
  statusFetchedAt?: number;
  /**
   * True when this call did not use a `dumpuser` result. The key stays at
   * GUID or IP.
   */
  dumpuserSkipped: boolean;
}

export interface PlayerIdentityResolverDeps {
  /** Defaults to `Date.now`. Tests pass a fake clock. Does not start a timer. */
  now?: () => number;
  dumpuser?: (serverAlias: string, strippedName: string) => Promise<CvarMap>;
  status?: (serverAlias: string) => Promise<{
    players: readonly StatusPlayer[];
  }>;
}

/**
 * Best stable id for one player. `cl_hwid` `0` and guid `0` are never keys.
 * A missing or failed `dumpuser` leaves the key at GUID, else IP.
 * `StatusPlayer.ip` is already the host, with no port.
 */
export function playerIdentityKey(
  player: Pick<StatusPlayer, 'guid' | 'ip'>,
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
  const ip = player.ip?.trim();
  if (ip) {
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

function isFresh(fetchedAt: number | undefined, at: number): boolean {
  return (
    fetchedAt !== undefined &&
    at >= fetchedAt &&
    at - fetchedAt <= FRESH_STATUS_MS
  );
}

/**
 * Resolves one player when the caller asks. No timer and no RCON until
 * `resolve`. A fresh status row (the ban sweep's, from the last 10 seconds)
 * is used as-is. A stale row costs one `status` and does not also `dumpuser`
 * in that same second. Another resolve waits out an in-flight command, then
 * one second from when that command settled.
 */
export function createPlayerIdentityResolver(
  deps: PlayerIdentityResolverDeps = {},
) {
  const now = deps.now ?? (() => Date.now());
  const lastRconAt = new Map<string, number>();
  const inFlight = new Set<string>();

  function blocked(serverAlias: string, at: number): boolean {
    if (inFlight.has(serverAlias)) {
      return true;
    }
    const last = lastRconAt.get(serverAlias);
    return last !== undefined && at - last < IDENTITY_RCON_INTERVAL_MS;
  }

  async function run<T>(
    serverAlias: string,
    command: () => Promise<T>,
  ): Promise<T> {
    inFlight.add(serverAlias);
    try {
      return await command();
    } finally {
      inFlight.delete(serverAlias);
      lastRconAt.set(serverAlias, now());
    }
  }

  function fromRow(
    player: StatusPlayer,
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
      let player = input.player;
      let statusFetchedAt = input.statusFetchedAt;

      // A stale num can belong to someone else. Refreshing it spends this
      // second's identity command, so dumpuser waits for the next call.
      const readStatus = deps.status;
      if (!isFresh(statusFetchedAt, at) && readStatus) {
        if (blocked(input.serverAlias, at)) {
          return fromRow(player, statusFetchedAt, true);
        }
        try {
          const status = await run(input.serverAlias, () =>
            readStatus(input.serverAlias),
          );
          const found = status.players.find((row) => row.num === player.num);
          if (found) {
            player = found;
            statusFetchedAt = now();
          }
        } catch {
          // Status was still the identity command for this second.
        }
        return fromRow(player, statusFetchedAt, true);
      }

      const readDumpuser = deps.dumpuser;
      if (!readDumpuser) {
        return fromRow(player, statusFetchedAt, true);
      }

      // Callers strip before dumpuser. Strip here too so a colored status
      // name cannot miss; RconClient strips again and does the quoting.
      const name = sanitizeRconArg(stripColorCodes(player.name));
      if (name === '' || blocked(input.serverAlias, at)) {
        return fromRow(player, statusFetchedAt, true);
      }

      try {
        const userinfo = await run(input.serverAlias, () =>
          readDumpuser(input.serverAlias, name),
        );
        return fromRow(player, statusFetchedAt, false, userinfo);
      } catch (error) {
        if (error instanceof DumpuserReplyError) {
          console.error(
            `dumpuser for "${name}" on "${input.serverAlias}" was not userinfo:`,
            error,
          );
        }
        return fromRow(player, statusFetchedAt, false);
      }
    },
  };
}
