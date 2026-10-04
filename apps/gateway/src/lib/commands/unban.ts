import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag } from '../resolve-server.js';
import { sanitizeRconArg } from '../sanitize.js';

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isIpv4(value: string): boolean {
  return IPV4_PATTERN.test(value) && value.split('.').every((octet) => Number(octet) <= 255);
}

/**
 * `/unban <guid-or-ip>` (docs/PLAN.md §6). Bans are global (§7), so this lifts the ban on every
 * server; a `--server` flag is accepted for backwards compatibility but ignored.
 *
 * An IP target only ever lives in `ban_ips` (§7 — never written to `ban.txt`), so stamping
 * `unbannedAt` is enough for the poller to stop enforcing it. A GUID target is also in the
 * issuing server's `ban.txt`, so every server is asked to `unbanUser` it — that also clears
 * a GUID someone banned on a server directly, outside the bot.
 */
export async function unbanCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { rest } = extractServerFlag(matchText(ctx));
  const target = sanitizeRconArg(rest);
  if (!target) {
    await ctx.reply('Usage: /unban <guid-or-ip>');
    return;
  }

  const ip = isIpv4(target);
  const lifted = ip ? await deps.banStore.unbanIp(target) : await deps.banStore.unbanByGuid(target);

  const unanswered: string[] = [];
  if (!ip) {
    const servers = [...deps.rconClients];
    const results = await Promise.allSettled(servers.map(([, rcon]) => rcon.unbanUser(target)));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        unanswered.push(servers[i][0]);
      }
    });
  }

  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'unban',
    target,
    serverAlias: null,
    source: 'telegram_command',
    detailJson: { lifted, ...(unanswered.length > 0 ? { unanswered } : {}) },
  });

  const what = ip ? `IP ${target}` : `GUID ${target}`;
  const lines = [
    lifted > 0
      ? `Unbanned ${what} on all servers.`
      : `No active ban for ${what} was recorded by the bot${ip ? '' : ' — asked every server to remove it from ban.txt anyway'}.`,
  ];
  if (unanswered.length > 0) {
    lines.push(
      `${unanswered.join(', ')} didn't answer, so its ban.txt may still have the GUID — run /unban ${target} again later.`,
    );
  }
  await ctx.reply(lines.join('\n'));
}
