import type { RconClient } from '@cod2admin/rcon-client';
import { Bot } from 'grammy';
import { requireOwner } from './auth.js';
import { banCommand } from './commands/ban.js';
import { kickCommand } from './commands/kick.js';
import { mapCommand } from './commands/map.js';
import { playersCommand } from './commands/players.js';
import { STATUS_REFRESH_CALLBACK_DATA, statusCommand, statusRefreshCallback } from './commands/status.js';
import { unbanCommand } from './commands/unban.js';
import type { GatewayConfig } from './config.js';

/**
 * Phase 1 Telegram MVP (docs/PLAN.md §9): owner-only, single hardcoded server, no roles/
 * audit-log yet — every command here is a thin wrapper straight over `rcon-client`.
 */
export function createBot(config: GatewayConfig, rcon: RconClient): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.use(requireOwner(config.ownerTelegramId));

  bot.command('status', (ctx) => statusCommand(ctx, rcon));
  bot.command('players', (ctx) => playersCommand(ctx, rcon));
  bot.command('kick', (ctx) => kickCommand(ctx, rcon));
  bot.command('ban', (ctx) => banCommand(ctx, rcon));
  bot.command('unban', (ctx) => unbanCommand(ctx, rcon));
  bot.command('map', (ctx) => mapCommand(ctx, rcon));

  bot.callbackQuery(STATUS_REFRESH_CALLBACK_DATA, (ctx) => statusRefreshCallback(ctx, rcon));

  bot.catch(({ error, ctx }) => {
    console.error(`Gateway bot error handling update ${ctx.update.update_id}:`, error);
  });

  return bot;
}
