import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

/**
 * `/bindserver <alias> [public]` — binds this chat to a server (docs/PLAN.md §4).
 *
 * Without `public` the chat becomes the server's admin chat (`!report` cards). With it, the chat is
 * the public group that gets the match results. They are separate slots, so they can be different chats.
 */
export async function bindServerCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  const [alias, kindWord, ...extra] = matchText(ctx).split(/\s+/).filter(Boolean);
  const usage = 'Usage: /bindserver <alias> [public]';
  if (!alias || extra.length > 0) {
    await ctx.reply(usage);
    return;
  }
  if (kindWord !== undefined && kindWord.toLowerCase() !== 'public') {
    await ctx.reply(usage);
    return;
  }
  if (!ctx.chat) {
    await ctx.reply('This command only makes sense in a group chat.');
    return;
  }
  if (!deps.rconClients.has(alias)) {
    await ctx.reply(
      `Unknown server "${alias}". Run /servers to see what's configured.`,
    );
    return;
  }

  if (kindWord) {
    await deps.adminStore.bindServerToChat(alias, ctx.chat.id, 'public');
    await ctx.reply(
      `This chat is now the public group for server "${alias}" (match results).`,
    );
    return;
  }
  await deps.adminStore.bindServerToChat(alias, ctx.chat.id);
  await ctx.reply(
    `This chat is now the admin chat for server "${alias}" (reports).`,
  );
}
