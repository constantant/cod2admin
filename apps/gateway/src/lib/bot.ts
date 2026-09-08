import { Bot, type Context } from 'grammy';
import { requireRole } from './auth.js';
import type { BotContext } from './bot-context.js';
import { addAdminCommand } from './commands/addadmin.js';
import { auditLogCommand } from './commands/auditlog.js';
import { banCommand } from './commands/ban.js';
import { bansCommand } from './commands/bans.js';
import { bindServerCommand } from './commands/bindserver.js';
import { claimCommand } from './commands/claim.js';
import { helpCommand, helpRuCommand } from './commands/help.js';
import { kickCommand } from './commands/kick.js';
import { listAdminsCommand } from './commands/listadmins.js';
import { mapCommand } from './commands/map.js';
import { mapsCommand, mapsSelectCallback, type MapsCallbackContext } from './commands/maps.js';
import { playersCommand } from './commands/players.js';
import { rconCommand } from './commands/rcon.js';
import { removeAdminCommand } from './commands/removeadmin.js';
import { reportActionCallback, type ReportCallbackContext } from './reports.js';
import { sayCommand } from './commands/say.js';
import { serversCommand } from './commands/servers.js';
import { setRoleCommand } from './commands/setrole.js';
import { STATUS_REFRESH_CALLBACK_DATA, statusCommand, statusRefreshCallback } from './commands/status.js';
import { tempbanCommand } from './commands/tempban.js';
import { unbanCommand } from './commands/unban.js';
import { updateActionCallback, updateCommand, type UpdateCallbackContext } from './commands/update.js';
import type { GatewayConfig } from './config.js';
import type { GatewayDeps } from './deps.js';

/**
 * Phase 2 Telegram bot (docs/PLAN.md §9): role-gated (owner/admin/moderator), multi-server,
 * audited. Role gates per §4: owner-only for /auditlog and /rcon; owner+admin for admin
 * management, /ban, /unban, /bans, /map, /bindserver, /say; any role for read-only/low-risk actions.
 * /claim has no gate — it must work before any admin exists.
 */
/**
 * The Bot API has no reliable way to resolve `@username` to an ID without that user having
 * started the bot, so `/addadmin`/`/removeadmin`/`/setrole` resolve their target via "reply to
 * their message" instead (docs/PLAN.md §4's "reply-or-@user") — this reads that off grammy's
 * real `Context`, which `BotContext` deliberately doesn't expose (grammy-agnostic by design).
 */
function withReplyToUserId(ctx: Context): BotContext {
  const target = ctx as BotContext;
  target.replyToUserId = ctx.message?.reply_to_message?.from?.id;
  return target;
}

/** Adapts grammy's real `Context` to `ReportCallbackContext` — mirrors `EditableBotContext`'s approach in status.ts. */
function toReportCallbackContext(ctx: Context & BotContext): ReportCallbackContext {
  return {
    from: ctx.from,
    admin: ctx.admin,
    callbackData: ctx.callbackQuery?.data ?? '',
    editMessageText: (text, other) => ctx.editMessageText(text, other as never),
    answerCallbackQuery: (other) => ctx.answerCallbackQuery(other),
  };
}

/** Same adaptation as `toReportCallbackContext`, minus `from` — `/maps`'s buttons don't need it. */
function toMapsCallbackContext(ctx: Context & BotContext): MapsCallbackContext {
  return {
    admin: ctx.admin,
    callbackData: ctx.callbackQuery?.data ?? '',
    editMessageText: (text, other) => ctx.editMessageText(text, other as never),
    answerCallbackQuery: (other) => ctx.answerCallbackQuery(other),
  };
}

/** Same adaptation as `toReportCallbackContext`, plus `chat` — `/update`'s pending-update marker needs the chat id. */
function toUpdateCallbackContext(ctx: Context & BotContext): UpdateCallbackContext {
  return {
    from: ctx.from,
    chat: ctx.chat,
    admin: ctx.admin,
    callbackData: ctx.callbackQuery?.data ?? '',
    editMessageText: (text, other) => ctx.editMessageText(text, other as never),
    answerCallbackQuery: (other) => ctx.answerCallbackQuery(other),
  };
}

export function createBot(config: GatewayConfig, deps: GatewayDeps, claimSecret: string): Bot {
  const bot = new Bot(config.telegramBotToken);

  const requireOwner = requireRole('owner', deps.adminStore);
  const requireAdmin = requireRole('admin', deps.adminStore);
  const requireAny = requireRole('moderator', deps.adminStore);

  bot.command('claim', (ctx) => claimCommand(ctx, deps, claimSecret));
  bot.command('help', (ctx) => helpCommand(ctx));
  bot.command('help_ru', (ctx) => helpRuCommand(ctx));

  bot.command('status', requireAny, (ctx) => statusCommand(ctx, deps));
  bot.command('players', requireAny, (ctx) => playersCommand(ctx, deps));
  bot.command('kick', requireAny, (ctx) => kickCommand(ctx, deps));
  bot.command('tempban', requireAny, (ctx) => tempbanCommand(ctx, deps));
  bot.command('servers', requireAny, (ctx) => serversCommand(ctx, deps));

  bot.command('ban', requireAdmin, (ctx) => banCommand(ctx, deps));
  bot.command('unban', requireAdmin, (ctx) => unbanCommand(ctx, deps));
  bot.command('bans', requireAdmin, (ctx) => bansCommand(ctx, deps));
  bot.command('map', requireAdmin, (ctx) => mapCommand(ctx, deps));
  bot.command('maps', requireAdmin, (ctx) => mapsCommand(ctx, deps));
  bot.command('say', requireAdmin, (ctx) => sayCommand(ctx, deps));
  bot.command('bindserver', requireAdmin, (ctx) => bindServerCommand(ctx, deps));
  bot.command('addadmin', requireAdmin, (ctx) => addAdminCommand(withReplyToUserId(ctx), deps));
  bot.command('removeadmin', requireAdmin, (ctx) => removeAdminCommand(withReplyToUserId(ctx), deps));
  bot.command('setrole', requireAdmin, (ctx) => setRoleCommand(withReplyToUserId(ctx), deps));
  bot.command('listadmins', requireAdmin, (ctx) => listAdminsCommand(ctx, deps));

  bot.command('auditlog', requireOwner, (ctx) => auditLogCommand(ctx, deps));
  bot.command('rcon', requireOwner, (ctx) => rconCommand(ctx, deps));
  bot.command('update', requireOwner, (ctx) => updateCommand(ctx, deps));

  bot.callbackQuery(STATUS_REFRESH_CALLBACK_DATA, requireAny, (ctx) => statusRefreshCallback(ctx, deps));
  bot.callbackQuery(/^map:/, requireAdmin, (ctx) => mapsSelectCallback(toMapsCallbackContext(ctx), deps));
  bot.callbackQuery(/^update:/, requireOwner, (ctx) => updateActionCallback(toUpdateCallbackContext(ctx), deps));
  bot.callbackQuery(/^report:/, requireAny, (ctx) =>
    reportActionCallback(toReportCallbackContext(ctx), {
      bot,
      registry: deps.reportRegistry,
      antiSpam: deps.reportAntiSpam,
      rconClients: deps.rconClients,
      adminStore: deps.adminStore,
      banStore: deps.banStore,
      sessionsByServer: deps.sessionsByServer,
    }),
  );

  bot.catch(({ error, ctx }) => {
    console.error(`Gateway bot error handling update ${ctx.update.update_id}:`, error);
  });

  return bot;
}
