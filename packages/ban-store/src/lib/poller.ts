import type { RconClient } from '@cod2admin/rcon-client';
import type { BanStore } from './types.js';

/** Called once per server that failed during a sweep, so one bad server doesn't hide the rest. */
export type SweepErrorHandler = (serverAlias: string, error: unknown) => void;

const logSweepError: SweepErrorHandler = (serverAlias, error) => {
  console.error(`Ban sweep failed for server "${serverAlias}":`, error);
};

function isUsableGuid(guid: string | null | undefined): guid is string {
  return !!guid && guid !== '0';
}

/**
 * The gateway's one non-event-driven action (docs/PLAN.md §3/§5.7), run on a fixed interval.
 * Bans apply to **every** managed server, not just the one they were issued on (docs/PLAN.md §7,
 * "Bans are global"):
 *
 * - (a) Kicks any connected player, on any server, whose IP matches an active `ban_ips` row or
 *   whose GUID matches an active `bans` row. GUID bans are also in the issuing server's
 *   `ban.txt` (the game enforces those itself), but no other server's, so this sweep is what
 *   enforces them everywhere else.
 * - (b) Drops `ban_ips` rows whose `expiresAt` has passed. No rcon call is needed, since IP bans
 *   were never written to ban.txt.
 *
 * Nothing is queried when there are no active bans, to keep load off rate-limited servers. A
 * server that fails (e.g. doesn't answer) is reported via `onError` and skipped; the others are
 * still swept.
 */
export async function runBanEnforcementSweep(
  banStore: BanStore,
  rconClients: Map<string, RconClient>,
  onError: SweepErrorHandler = logSweepError,
): Promise<void> {
  const now = new Date();
  const [ipBans, guidBans, expiredIpBans] = await Promise.all([
    banStore.listActiveIpBans(),
    banStore.listActiveBans(),
    banStore.listExpiredIpBans(now),
  ]);

  const bannedIps = new Set(ipBans.map((ban) => ban.ip));
  const bannedGuids = new Set(guidBans.map((ban) => ban.guid).filter(isUsableGuid));

  if (bannedIps.size > 0 || bannedGuids.size > 0) {
    for (const [serverAlias, rcon] of rconClients) {
      try {
        const { players } = await rcon.status();
        for (const player of players) {
          const ipBanned = !!player.ip && bannedIps.has(player.ip);
          const guidBanned = isUsableGuid(player.guid) && bannedGuids.has(player.guid);
          if (ipBanned || guidBanned) {
            // Some servers' `kick` rcon command only accepts a player's name, not the numeric
            // slot `status` reports (confirmed empirically — see apps/gateway's kick.ts).
            await rcon.kick(player.name);
          }
        }
      } catch (error) {
        onError(serverAlias, error);
      }
    }
  }

  for (const ban of expiredIpBans) {
    await banStore.expireIpBan(ban.id);
  }
}

/**
 * The GUID-path half of the poller's expiry job (docs/PLAN.md §5 step 7's job (b)). A GUID ban
 * was written to `ban.txt` on the server it was issued on (`Ban.serverAlias`), so reversing it
 * needs `unbanUser(guid)` *there* before the row is dropped. If that server doesn't answer, the
 * row is kept and retried on the next tick. If that server is no longer managed
 * (`/removeserver`), there's nothing left to undo, so the row is just dropped. A `null` guid
 * can't have been banned this way (§2.4's GUID-0 case goes through `ban_ips`) and is only dropped.
 */
export async function runBanExpirySweep(
  banStore: BanStore,
  rconClients: Map<string, RconClient>,
  onError: SweepErrorHandler = logSweepError,
): Promise<void> {
  const expiredBans = await banStore.listExpiredBans(new Date());
  for (const ban of expiredBans) {
    const origin = rconClients.get(ban.serverAlias);
    if (ban.guid && origin) {
      try {
        await origin.unbanUser(ban.guid);
      } catch (error) {
        onError(ban.serverAlias, error);
        continue;
      }
    }
    await banStore.expireBan(ban.id);
  }
}
