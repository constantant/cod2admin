import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';
import { sanitizeRconArg } from '../sanitize.js';

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isIpv4(value: string): boolean {
  return IPV4_PATTERN.test(value) && value.split('.').every((octet) => Number(octet) <= 255);
}

/**
 * `/unban <guid-or-ip> [--server <alias>]` (docs/PLAN.md §6). A GUID target calls the game
 * server's `unbanUser` rcon command (removes the `ban.txt` entry) and stamps `unbannedAt` on
 * matching `bans` rows so `/bans` stops listing it. An IP target only ever lives in `ban_ips`
 * (§7 — the GUID-0 fallback never writes to `ban.txt`), so there's no rcon call for it — just
 * stamping `unbannedAt` so the poller's kick-on-sight sweep (`runIpBanSweep`) stops enforcing it.
 */
export async function unbanCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias, rest } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  const target = sanitizeRconArg(rest);
  if (!target) {
    await ctx.reply('Usage: /unban <guid-or-ip> [--server <alias>]');
    return;
  }

  if (isIpv4(target)) {
    await deps.banStore.unbanIp(server.alias, target);
    await deps.adminStore.recordAuditLog({
      actorTelegramId: ctx.admin!.telegramId,
      action: 'unban',
      target,
      serverAlias: server.alias,
      source: 'telegram_command',
    });
    await ctx.reply(`Unbanned IP ${target}.`);
    return;
  }

  await server.rcon.unbanUser(target);
  await deps.banStore.unbanByGuid(server.alias, target);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'unban',
    target,
    serverAlias: server.alias,
    source: 'telegram_command',
  });
  await ctx.reply(`Unbanned GUID ${target}.`);
}
