import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../bot-context.js';

export const APP_BUTTON_TEXT = 'Server manager';

/**
 * `/app` — opens the Mini App (docs/PLAN-miniapp.md). Telegram only allows Mini App buttons in
 * private chats, so in a group this points at the bot's private chat instead, where the menu
 * button opens it too. Without `MINIAPP_URL` there's nothing to open.
 */
export async function appCommand(
  ctx: BotContext,
  miniAppUrl: string | undefined,
  botUsername: string | undefined,
): Promise<void> {
  if (!miniAppUrl) {
    await ctx.reply(
      "The server manager app isn't set up on this bot. The bot's owner can turn it on by setting MINIAPP_PORT and MINIAPP_URL (see installer/README.md).",
    );
    return;
  }
  if (ctx.chat?.type === 'private') {
    await ctx.reply('Manage the server from a full-screen app:', {
      reply_markup: new InlineKeyboard().webApp(APP_BUTTON_TEXT, miniAppUrl),
    });
    return;
  }
  await ctx.reply(
    'The server manager opens in a private chat with the bot — use its menu button there.',
    botUsername
      ? {
          reply_markup: new InlineKeyboard().url(
            'Open the bot',
            `https://t.me/${botUsername}`,
          ),
        }
      : undefined,
  );
}
