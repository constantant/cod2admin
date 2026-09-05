import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';

/**
 * `/rcon <raw command> [--server <alias>]` — owner-only raw passthrough (docs/PLAN.md §6/§8).
 * The one intentional exception to sanitizing rcon arguments — logged verbatim regardless.
 */
export async function rconCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias, rest } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  if (!rest) {
    await ctx.reply('Usage: /rcon <raw command> [--server <alias>]');
    return;
  }

  const result = await server.rcon.rcon(rest);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'rcon',
    target: rest,
    serverAlias: server.alias,
    source: 'telegram_command',
    detailJson: { command: rest },
  });
  await ctx.reply(result || '(no output)');
}
