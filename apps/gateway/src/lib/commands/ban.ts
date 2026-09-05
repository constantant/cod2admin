import { matchText, type BotContext } from '../bot-context.js';
import { broadcastModerationAction } from '../broadcast.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';
import { sanitizeRconArg } from '../sanitize.js';

/**
 * `/ban <client id> [reason] [--server <alias>]` — permanent, native GUID path (docs/PLAN.md
 * §9 Phase 2 plan). `bans.guid` is recorded as unknown: no rcon command exposes a connected
 * player's real GUID (only log-tailing games_mp.log does — Phase 3), so this can't be captured
 * here. The confirmation surfaces the target's current IP so the admin can follow up with
 * `/tempban` (IP-based) if this ban doesn't stick — empirically common on this server.
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
  const reason = sanitizeRconArg(reasonParts.join(' '));

  const { players } = await server.rcon.status();
  const player = players.find((candidate) => candidate.num === clientId);

  await server.rcon.banUser(clientId);

  await deps.banStore.recordBan({
    serverAlias: server.alias,
    name: player?.name ?? `client ${clientId}`,
    reason: reason || null,
    bannedBy: ctx.admin!.telegramId,
  });

  const label = reason ? `client ${clientId} (${reason})` : `client ${clientId}`;
  await broadcastModerationAction(server.rcon, label, 'banned');
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'ban',
    target: player?.name ?? String(clientId),
    serverAlias: server.alias,
    reason,
    source: 'telegram_command',
  });

  const ipNote = player?.ip ? ` IP: ${player.ip} (note this in case the ban doesn't stick — common on this server.)` : '';
  await ctx.reply(`Banned client ${clientId}${reason ? ` for: ${reason}` : ''}.${ipNote}`);
}
