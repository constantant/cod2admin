import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { executeModerationAction } from '../moderation-actions.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';

/**
 * `/ban <client id> [reason] [--server <alias>]` — permanent. GUID path when `status()` reports
 * one (§2.4 found some server builds do); IP-fallback via `executeModerationAction` otherwise
 * (§5 step 7) — this server's GUID-0 finding means that fallback is the common case here, not a
 * rare one, so `/ban` requires the target still be connected (like `/tempban` already does) —
 * there's nothing left to ban by (no GUID, no IP) once they're gone.
 */
export async function banCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias, rest } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  const [idToken, ...reasonParts] = rest.split(/\s+/).filter(Boolean);
  const clientId = idToken === undefined ? NaN : Number.parseInt(idToken, 10);
  if (idToken === undefined || Number.isNaN(clientId)) {
    await ctx.reply('Usage: /ban <client id> [reason] [--server <alias>]');
    return;
  }
  const reason = reasonParts.join(' ');

  const { players } = await server.rcon.status();
  const player = players.find((candidate) => candidate.num === clientId);
  if (!player) {
    await ctx.reply(`Client ${clientId} is not currently connected — cannot ban.`);
    return;
  }

  const result = await executeModerationAction(
    'ban',
    { num: player.num, name: player.name, guid: player.guid, ip: player.ip },
    {
      serverAlias: server.alias,
      rcon: server.rcon,
      banStore: deps.banStore,
      adminStore: deps.adminStore,
      actorTelegramId: ctx.admin!.telegramId,
      reason: reason || null,
      source: 'telegram_command',
    },
  );

  await ctx.reply(`${result.label} ${player.name}${reason ? ` for: ${reason}` : ''}.`);
}
