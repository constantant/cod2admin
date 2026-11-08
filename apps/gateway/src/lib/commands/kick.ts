import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { executeModerationAction } from '../moderation-actions.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';
import { sanitizeRconArg } from '../sanitize.js';

/**
 * `/kick <client id or name> [--server <alias>]` — same rcon call as the report-card button (§6).
 *
 * A numeric target is checked against `status()` so we don't `clientkick` an empty slot. A name
 * is passed through; `RconClient#kick` quotes it if the first attempt misses.
 */
export async function kickCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  const { alias: serverAlias, rest } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  const target = sanitizeRconArg(rest);
  if (!target) {
    await ctx.reply('Usage: /kick <client id or name> [--server <alias>]');
    return;
  }

  let kickTarget = target;
  let clientId = Number.parseInt(target, 10);
  if (!Number.isNaN(clientId) && String(clientId) === target) {
    const { players } = await server.rcon.status();
    const player = players.find((candidate) => candidate.num === clientId);
    if (!player) {
      await ctx.reply(`Client ${clientId} is not currently connected.`);
      return;
    }
    kickTarget = player.name;
  } else {
    clientId = -1; // a raw name, not a resolved slot — irrelevant to executeModerationAction's kick branch
  }

  await executeModerationAction(
    'kick',
    { num: clientId, name: kickTarget },
    {
      serverAlias: server.alias,
      rcon: server.rcon,
      banStore: deps.banStore,
      adminStore: deps.adminStore,
      actorTelegramId: ctx.admin!.telegramId,
      source: 'telegram_command',
      chatTemplates: deps.chatTemplates,
    },
  );
  await ctx.reply(`Kicked ${kickTarget}.`);
}
