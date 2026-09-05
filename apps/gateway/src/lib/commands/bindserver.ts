import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

/** `/bindserver <alias>` — binds this chat to a server (docs/PLAN.md §4). */
export async function bindServerCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const alias = matchText(ctx);
  if (!alias) {
    await ctx.reply('Usage: /bindserver <alias>');
    return;
  }
  if (!ctx.chat) {
    await ctx.reply('This command only makes sense in a group chat.');
    return;
  }
  if (!deps.rconClients.has(alias)) {
    await ctx.reply(`Unknown server "${alias}". Run /servers to see what's configured.`);
    return;
  }

  await deps.adminStore.bindServerToChat(alias, ctx.chat.id);
  await ctx.reply(`This chat is now bound to server "${alias}".`);
}
