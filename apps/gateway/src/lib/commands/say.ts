import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';
import { sanitizeRconArg } from '../sanitize.js';

/** `/say <message> [--server <alias>]` (docs/PLAN.md §6). */
export async function sayCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias, rest } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  const message = sanitizeRconArg(rest);
  if (!message) {
    await ctx.reply('Usage: /say <message> [--server <alias>]');
    return;
  }

  await server.rcon.say(message);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'say',
    target: message,
    serverAlias: server.alias,
    source: 'telegram_command',
  });
  await ctx.reply('Sent.');
}
