import { isBanFileSafeName } from '@cod2admin/rcon-client';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag } from '../resolve-server.js';
import { sanitizeRconArg } from '../sanitize.js';

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** How much of a GUID's ban history to look through for `ban.txt` entries to remove. */
const BAN_HISTORY_LIMIT = 50;

function isIpv4(value: string): boolean {
  return IPV4_PATTERN.test(value) && value.split('.').every((octet) => Number(octet) <= 255);
}

/**
 * `/unban <guid-or-ip>` (docs/PLAN.md §6). Bans are global (§7), so this lifts the ban on every
 * server; a `--server` flag is accepted for backwards compatibility but ignored.
 *
 * An IP target only ever lives in `ban_ips` (§7 — never written to `ban.txt`), so stamping
 * `unbannedAt` is enough for the poller to stop enforcing it. So is a GUID temp ban. A permanent
 * GUID ban may also be in its issuing server's `ban.txt`, and `unbanUser` removes those by player
 * **name**, not GUID (§2.4 "ban.txt"), so each server that issued one is asked to remove the
 * name it was recorded under. That list comes from the GUID's whole ban history, not just the
 * bans lifted now, so running `/unban` again retries a server that didn't answer the first time.
 */
export async function unbanCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { rest } = extractServerFlag(matchText(ctx));
  const target = sanitizeRconArg(rest);
  if (!target) {
    await ctx.reply('Usage: /unban <guid-or-ip>');
    return;
  }

  const ip = isIpv4(target);
  const unanswered: string[] = [];
  const notFound: string[] = [];
  let lifted: number;

  if (ip) {
    lifted = await deps.banStore.unbanIp(target);
  } else {
    const history = await deps.banStore.listBansByGuid(target, BAN_HISTORY_LIMIT);
    const liftedBans = await deps.banStore.unbanByGuid(target);
    lifted = liftedBans.length;
    const liftedIds = new Set(liftedBans.map((ban) => ban.id));

    // One `unbanUser` per server and name — only permanent bans issued under a name that was
    // safe to write to ban.txt can be in there (see moderation-actions.ts).
    const entries = new Map<string, { serverAlias: string; name: string; liftedNow: boolean }>();
    for (const ban of history) {
      if (ban.expiresAt !== null || !isBanFileSafeName(ban.name) || !deps.rconClients.has(ban.serverAlias)) {
        continue;
      }
      const key = `${ban.serverAlias}\n${ban.name}`;
      const entry = entries.get(key) ?? { serverAlias: ban.serverAlias, name: ban.name, liftedNow: false };
      entry.liftedNow ||= liftedIds.has(ban.id);
      entries.set(key, entry);
    }

    const pending = [...entries.values()];
    const results = await Promise.allSettled(
      pending.map(({ serverAlias, name }) => deps.rconClients.get(serverAlias)!.unbanUser(name)),
    );
    results.forEach((result, i) => {
      const { serverAlias, name, liftedNow } = pending[i];
      if (result.status === 'rejected') {
        unanswered.push(serverAlias);
      } else if (result.value === 0 && liftedNow) {
        notFound.push(`${serverAlias} (${name})`);
      }
    });
  }

  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'unban',
    target,
    serverAlias: null,
    source: 'telegram_command',
    detailJson: {
      lifted,
      ...(unanswered.length > 0 ? { unanswered } : {}),
      ...(notFound.length > 0 ? { notFound } : {}),
    },
  });

  const what = ip ? `IP ${target}` : `GUID ${target}`;
  const lines = [lifted > 0 ? `Unbanned ${what} on all servers.` : `No active ban for ${what} was recorded by the bot.`];
  if (unanswered.length > 0) {
    lines.push(
      `${[...new Set(unanswered)].join(', ')} didn't answer, so its ban.txt may still block this player — run /unban ${target} again later.`,
    );
  }
  if (notFound.length > 0) {
    lines.push(`No ban.txt entry to remove on ${notFound.join(', ')}.`);
  }
  await ctx.reply(lines.join('\n'));
}
