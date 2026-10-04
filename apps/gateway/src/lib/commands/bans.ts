import type { Ban, BanIp } from '@cod2admin/ban-store';
import type { BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

function formatExpiry(expiresAt: Date | null): string {
  return expiresAt ? `expires ${expiresAt.toISOString()}` : 'permanent';
}

function formatGuidBan(ban: Ban): string {
  const reason = ban.reason ? ` (${ban.reason})` : '';
  return `${ban.guid ?? 'unknown guid'} — ${ban.name}${reason} — ${formatExpiry(ban.expiresAt)} — banned on ${ban.serverAlias}`;
}

function formatIpBan(ban: BanIp): string {
  const reason = ban.reason ? ` (${ban.reason})` : '';
  return `${ban.ip}${reason} — ${formatExpiry(ban.expiresAt)} — banned on ${ban.serverAlias}`;
}

export function formatBansMessage(guidBans: Ban[], ipBans: BanIp[]): string {
  if (guidBans.length === 0 && ipBans.length === 0) {
    return 'No active bans.';
  }

  const sections: string[] = ['Active bans (they apply on all servers):'];
  if (guidBans.length > 0) {
    sections.push(['GUID bans:', ...guidBans.map((ban) => formatGuidBan(ban))].join('\n'));
  }
  if (ipBans.length > 0) {
    sections.push(['IP bans:', ...ipBans.map((ban) => formatIpBan(ban))].join('\n'));
  }
  return sections.join('\n\n');
}

/**
 * `/bans` — lists currently active bans (both GUID-path `bans` and IP-path `ban_ips`,
 * docs/PLAN.md §7) so `/unban <guid-or-ip>` has something to target. Bans are global, so this
 * lists every server's, each with the server it was issued on; a `--server` flag is ignored.
 * A row leaves this list once its `expiresAt` passes (poller-driven) or `/unban` stamps its
 * `unbannedAt` — the row itself stays around as ban *history* (docs/PLAN.md §5 step 3).
 */
export async function bansCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const [guidBans, ipBans] = await Promise.all([deps.banStore.listActiveBans(), deps.banStore.listActiveIpBans()]);

  await ctx.reply(formatBansMessage(guidBans, ipBans));
}
