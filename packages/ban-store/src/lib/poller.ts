import type { RconClient } from '@cod2admin/rcon-client';
import type { BanStore } from './types.js';

/**
 * The gateway's one non-event-driven action (docs/PLAN.md §3/§5.7): on a fixed interval,
 * (a) kick any connected player whose IP matches an active `ban_ips` row, and (b) drop rows whose
 * `expiresAt` has passed. No rcon "unban" call is ever needed for IP bans — they were never
 * written to ban.txt, so "expiring" one is just deleting the row.
 */
export async function runIpBanSweep(banStore: BanStore, rconClients: Map<string, RconClient>): Promise<void> {
  const now = new Date();

  for (const [serverAlias, rcon] of rconClients) {
    const [activeBans, expiredBans] = await Promise.all([
      banStore.listActiveIpBans(serverAlias),
      banStore.listExpiredIpBans(serverAlias, now),
    ]);

    if (activeBans.length > 0) {
      const { players } = await rcon.status();
      const bannedIps = new Set(activeBans.map((ban) => ban.ip));
      for (const player of players) {
        if (player.ip && bannedIps.has(player.ip)) {
          // Some servers' `kick` rcon command only accepts a player's name, not the numeric
          // slot `status` reports (confirmed empirically — see apps/gateway's kick.ts).
          await rcon.kick(player.name);
        }
      }
    }

    for (const ban of expiredBans) {
      await banStore.expireIpBan(ban.id);
    }
  }
}
