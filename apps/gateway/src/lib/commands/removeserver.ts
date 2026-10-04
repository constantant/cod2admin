import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

/**
 * `/removeserver <alias>` — owner-only. Stops managing a server added with `/addserver`, right away.
 * The config-file server can't be removed: the bot re-adds it from `.env` on every start.
 */
export async function removeServerCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const alias = matchText(ctx);
  if (!alias) {
    await ctx.reply('Usage: /removeserver <alias>');
    return;
  }
  if (!deps.rconClients.has(alias)) {
    await ctx.reply(`Unknown server "${alias}". Run /servers to see what's configured.`);
    return;
  }
  if (alias === deps.bootstrapServerAlias) {
    await ctx.reply(
      `"${alias}" comes from the bot's config file and would come back on the next restart, so it can't be removed here.`,
    );
    return;
  }

  await deps.adminStore.removeServer(alias);
  deps.rconClients.delete(alias);
  deps.sessionsByServer.delete(alias);

  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'removeserver',
    target: alias,
    serverAlias: alias,
    source: 'telegram_command',
  });
  await ctx.reply(`Server "${alias}" removed.`);
}
