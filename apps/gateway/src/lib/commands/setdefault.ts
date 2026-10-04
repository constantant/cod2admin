import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

/** `/setdefault <alias>` — which server commands without `--server` go to (see resolve-server.ts). */
export async function setDefaultCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const alias = matchText(ctx);
  if (!alias) {
    await ctx.reply('Usage: /setdefault <alias>');
    return;
  }
  if (!deps.rconClients.has(alias)) {
    await ctx.reply(`Unknown server "${alias}". Run /servers to see what's configured.`);
    return;
  }

  await deps.adminStore.setDefaultServer(alias);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'setdefault',
    target: alias,
    serverAlias: alias,
    source: 'telegram_command',
  });
  await ctx.reply(
    `Commands without --server now go to "${alias}". ` +
      'Chats bound with /bindserver keep using their own server.',
  );
}
