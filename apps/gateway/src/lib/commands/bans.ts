import type { Ban, BanIp } from '@cod2admin/ban-store';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';

function formatExpiry(expiresAt: Date | null): string {
  return expiresAt ? `expires ${expiresAt.toISOString()}` : 'permanent';
}

function formatGuidBan(ban: Ban): string {
  const reason = ban.reason ? ` (${ban.reason})` : '';
  return `${ban.guid ?? 'unknown guid'} — ${ban.name}${reason} — ${formatExpiry(ban.expiresAt)}`;
}

function formatIpBan(ban: BanIp): string {
  const reason = ban.reason ? ` (${ban.reason})` : '';
  return `${ban.ip}${reason} — ${formatExpiry(ban.expiresAt)}`;
}

export function formatBansMessage(guidBans: Ban[], ipBans: BanIp[]): string {
  if (guidBans.length === 0 && ipBans.length === 0) {
    return 'No active bans.';
  }

  const sections: string[] = [];
  if (guidBans.length > 0) {
    sections.push(['GUID bans:', ...guidBans.map((ban) => formatGuidBan(ban))].join('\n'));
  }
  if (ipBans.length > 0) {
    sections.push(['IP bans:', ...ipBans.map((ban) => formatIpBan(ban))].join('\n'));
  }
  return sections.join('\n\n');
}

/**
 * `/bans [--server <alias>]` — lists currently active bans (both GUID-path `bans` and
 * IP-path `ban_ips`, docs/PLAN.md §7) so `/unban <guid-or-ip>` has something to target. A row
 * leaves this list once its `expiresAt` passes (poller-driven) or `/unban` stamps its
 * `unbannedAt` — the row itself stays around as ban *history* for `listBansByGuid`/etc.
 * (docs/PLAN.md §5 step 3), only `listActiveBans`/`listActiveIpBans` filter it out.
 */
export async function bansCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  const [guidBans, ipBans] = await Promise.all([
    deps.banStore.listActiveBans(server.alias),
    deps.banStore.listActiveIpBans(server.alias),
  ]);

  await ctx.reply(formatBansMessage(guidBans, ipBans));
}
