import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

/**
 * `/bindserver <alias> [private]` — binds this chat to a server (docs/PLAN.md §4).
 *
 * Without a keyword the chat becomes the server's public group (match results). With `private` it is
 * the admin chat (`!report` cards). They are separate slots, so they can be different chats.
 */
export async function bindServerCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  const [alias, kindWord, ...extra] = matchText(ctx)
    .split(/\s+/)
    .filter(Boolean);
  const usage = 'Usage: /bindserver <alias> [private]';
  const kind = kindWord?.toLowerCase();
  if (!alias || extra.length > 0 || (kind && kind !== 'private')) {
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

  if (kind === 'private') {
    await deps.adminStore.bindServerToChat(alias, ctx.chat.id, 'admin');
    await ctx.reply(
      `This chat is now the admin chat for server "${alias}" (reports).`,
    );
    return;
  }
  await deps.adminStore.bindServerToChat(alias, ctx.chat.id, 'public');
  await ctx.reply(
    `This chat is now the public group for server "${alias}" (match results).`,
  );
}
