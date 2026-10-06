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
 *   whose GUID matches an active `bans` row. Some permanent GUID bans are also in the issuing
 *   server's `ban.txt` (the game enforces those itself), but no other server's, and temp bans
 *   never are (§2.4 "ban.txt"), so this sweep is what enforces them everywhere else.
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
 * The GUID-path half of the poller's expiry job (docs/PLAN.md §5 step 7's job (b)): drops `bans`
 * rows whose `expiresAt` has passed. No rcon call is needed. A temp ban is never written to
 * `ban.txt`, only enforced by `runBanEnforcementSweep`, because `unbanUser` removes entries by
 * player name, not GUID, and can't reliably take one back out (§2.4 "ban.txt").
 */
export async function runBanExpirySweep(banStore: BanStore): Promise<void> {
  const expiredBans = await banStore.listExpiredBans(new Date());
  for (const ban of expiredBans) {
    await banStore.expireBan(ban.id);
  }
}
