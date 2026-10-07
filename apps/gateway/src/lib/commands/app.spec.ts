import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { appCommand } from './app.js';

const URL = 'https://1-2-3-4.sslip.io';

describe('appCommand', () => {
  it('sends a Mini App button in a private chat', async () => {
    const ctx = createFakeCtx({ chat: { id: 1, type: 'private' } });

    await appCommand(ctx, URL, 'my_bot');

    expect(ctx.reply).toHaveBeenCalledWith(
      'Manage the server from a full-screen app:',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Server manager', web_app: { url: URL } }],
          ],
        },
      },
    );
  });

  it('points a group at the private chat, where Mini App buttons work', async () => {
    const ctx = createFakeCtx({ chat: { id: -100, type: 'supergroup' } });

    await appCommand(ctx, URL, 'my_bot');

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('private chat'),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Open the bot', url: 'https://t.me/my_bot' }],
          ],
        },
      },
    );
  });

  it('says how to turn it on when MINIAPP_URL is not set', async () => {
    const ctx = createFakeCtx({ chat: { id: 1, type: 'private' } });

    await appCommand(ctx, undefined, 'my_bot');

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('MINIAPP_URL'),
    );
  });
});
