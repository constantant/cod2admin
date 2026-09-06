import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { executeModerationAction } from '../moderation-actions.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';

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
 * `/tempban <client id> [duration] [reason] [--server <alias>]` — GUID path when `status()`
 * reports one, IP-fallback otherwise (`executeModerationAction`, docs/PLAN.md §5 steps 6/7).
 * Never calls native `tempBanClient` — see the plan's "tempban mechanism" decision for why.
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
  const reason = reasonTokens.join(' ');

  const { players } = await server.rcon.status();
  const player = players.find((candidate) => candidate.num === clientId);
  if (!player) {
    await ctx.reply(`Client ${clientId} is not currently connected — cannot temp-ban.`);
    return;
  }

  const result = await executeModerationAction(
    'tempban',
    { num: player.num, name: player.name, guid: player.guid, ip: player.ip },
    {
      serverAlias: server.alias,
      rcon: server.rcon,
      banStore: deps.banStore,
      adminStore: deps.adminStore,
      actorTelegramId: ctx.admin!.telegramId,
      reason: reason || null,
      source: 'telegram_command',
      durationMs,
    },
  );

  await ctx.reply(`${result.label} ${player.name} for ${formatDuration(result.durationMs!)}.`);
}
