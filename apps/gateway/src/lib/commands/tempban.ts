import { matchText, type BotContext } from '../bot-context.js';
import { broadcastModerationAction } from '../broadcast.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';
import { sanitizeRconArg } from '../sanitize.js';

const DEFAULT_DURATION_MS = 30 * 60_000;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION_TOKEN = /^(\d+)(m|h|d)?$/;

function parseDurationMs(token: string | undefined): number | undefined {
  if (!token) {
    return undefined;
  }
  const match = DURATION_TOKEN.exec(token);
  if (!match) {
    return undefined;
  }
  return Number.parseInt(match[1], 10) * UNIT_MS[match[2] ?? 'm'];
}

export function formatDuration(ms: number): string {
  if (ms % UNIT_MS['d'] === 0) {
    return `${ms / UNIT_MS['d']}d`;
  }
  if (ms % UNIT_MS['h'] === 0) {
    return `${ms / UNIT_MS['h']}h`;
  }
  return `${Math.round(ms / UNIT_MS['m'])}m`;
}

/**
 * `/tempban <client id> [duration] [reason] [--server <alias>]` — IP-only in Phase 2 (docs/PLAN.md
 * §9 Phase 2 plan: no rcon command exposes a connected player's real GUID, so a GUID-based temp
 * ban could never be reversed later — see the plan's "tempban mechanism" decision). Kicks
 * immediately and IP-bans via `ban-store`'s `ban_ips`, enforced/expired purely by the poller.
 */
export async function tempbanCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias, rest } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  const [idToken, durationToken, ...reasonParts] = rest.split(/\s+/).filter(Boolean);
  const clientId = idToken === undefined ? NaN : Number.parseInt(idToken, 10);
  if (Number.isNaN(clientId)) {
    await ctx.reply('Usage: /tempban <client id> [duration] [reason] [--server <alias>]');
    return;
  }

  const durationMs = parseDurationMs(durationToken);
  // If the "duration" token didn't parse as one, it's actually the start of the reason.
  const reasonTokens = durationMs === undefined && durationToken ? [durationToken, ...reasonParts] : reasonParts;
  const reason = sanitizeRconArg(reasonTokens.join(' '));

  const { players } = await server.rcon.status();
  const player = players.find((candidate) => candidate.num === clientId);
  if (!player?.ip) {
    await ctx.reply(`Client ${clientId} is not currently connected (or has no IP) — cannot IP-ban.`);
    return;
  }

  // This server's `kick` rcon command only accepts a player's name, not the numeric slot
  // `status` reports (confirmed empirically — see kick.ts).
  await server.rcon.kick(player.name);

  const durationMsResolved = durationMs ?? DEFAULT_DURATION_MS;
  const expiresAt = new Date(Date.now() + durationMsResolved);
  await deps.banStore.recordIpBan({
    serverAlias: server.alias,
    ip: player.ip,
    reason: reason || null,
    bannedBy: ctx.admin!.telegramId,
    expiresAt,
  });

  await broadcastModerationAction(server.rcon, player.name, 'temp-banned');
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'tempban',
    target: player.name,
    serverAlias: server.alias,
    reason,
    source: 'telegram_command',
    detailJson: { ip: player.ip, durationMs: durationMsResolved },
  });
  await ctx.reply(
    `Temp-banned ${player.name}'s IP for ${formatDuration(durationMsResolved)}. ` +
      `(IP-based — GUID-based temp bans aren't reliable without Phase 3's log-tailer.)`,
  );
}
