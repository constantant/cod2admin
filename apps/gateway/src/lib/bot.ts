import type { Permission } from '@cod2admin/admin-store';
import { decodeText, UdpQueryTimeoutError } from '@cod2admin/rcon-client';
import { Agent } from 'node:https';
import { Bot, type Context } from 'grammy';
import { requirePermission, requireStaff } from './auth.js';
import type { BotContext } from './bot-context.js';
import { addAdminCommand } from './commands/addadmin.js';
import { appCommand } from './commands/app.js';
import { addServerCommand } from './commands/addserver.js';
import { auditLogCommand } from './commands/auditlog.js';
import { banCommand } from './commands/ban.js';
import { bansCommand } from './commands/bans.js';
import { bindServerCommand } from './commands/bindserver.js';
import { claimCommand } from './commands/claim.js';
import { findLogCommand } from './commands/findlog.js';
import { helpCommand, helpRuCommand } from './commands/help.js';
import { kickCommand } from './commands/kick.js';
import { listAdminsCommand } from './commands/listadmins.js';
import { mapCommand } from './commands/map.js';
import {
  mapsCommand,
  mapsSelectCallback,
  type MapsCallbackContext,
} from './commands/maps.js';
import { mcpCommand, mcpDecision, mcpStart } from './commands/mcp.js';
import { permitCommand } from './commands/permit.js';
import { playersCommand } from './commands/players.js';
import { rconCommand } from './commands/rcon.js';
import { removeAdminCommand } from './commands/removeadmin.js';
import { relaysCommand } from './commands/relays.js';
import { removeServerCommand } from './commands/removeserver.js';
import { startReportTailer } from './report-tailers.js';
import { reportActionCallback, type ReportCallbackContext } from './reports.js';
import { sayCommand } from './commands/say.js';
import { serversCommand } from './commands/servers.js';
import { setDefaultCommand } from './commands/setdefault.js';
import {
  STATUS_REFRESH_CALLBACK_DATA,
  statusCommand,
  statusRefreshCallback,
} from './commands/status.js';
import { tempbanCommand } from './commands/tempban.js';
import { templatesCommand } from './commands/templates.js';
import { unbanCommand } from './commands/unban.js';
import {
  updateActionCallback,
  updateCommand,
  type UpdateCallbackContext,
} from './commands/update.js';
import { knownCommand } from './commands/known.js';
import { vpnKickCommand } from './commands/vpnkick.js';
import { vpnNetsCommand } from './commands/vpnnets.js';
import { watchCommand } from './commands/watch.js';
import type { GatewayConfig } from './config.js';
import type { GatewayDeps } from './deps.js';
import {
  describeIpLong,
  describeProviderLong,
  joinCountryAndProvider,
} from './geoip.js';
import { describeVpnLong, joinIpLabels } from './vpn-ranges.js';
import { failoverTransformer, probeRoute } from './telegram-routes.js';

/**
 * Phase 2 Telegram bot (docs/PLAN.md §9): permission-gated, multi-server, audited. Each command
 * below names the permission it needs; a few are any staff member. /claim has no gate — it must
 * work before any admin exists.
 */
/**
 * The Bot API has no reliable way to resolve `@username` to an ID without that user having
 * started the bot, so `/addadmin`/`/removeadmin`/`/permit` resolve their target via "reply to
 * their message" instead (docs/PLAN.md §4's "reply-or-@user") — this reads that off grammy's
 * real `Context`, which `BotContext` deliberately doesn't expose (grammy-agnostic by design).
 */
function withReplyToUserId(ctx: Context): BotContext {
  const target = ctx as BotContext;
  target.replyToUserId = ctx.message?.reply_to_message?.from?.id;
  return target;
}

/** Adapts grammy's real `Context` to `ReportCallbackContext` — mirrors `EditableBotContext`'s approach in status.ts. */
function toReportCallbackContext(
  ctx: Context & BotContext,
): ReportCallbackContext {
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
function toUpdateCallbackContext(
  ctx: Context & BotContext,
): UpdateCallbackContext {
  return {
    from: ctx.from,
    chat: ctx.chat,
    admin: ctx.admin,
    callbackData: ctx.callbackQuery?.data ?? '',
    editMessageText: (text, other) => ctx.editMessageText(text, other as never),
    answerCallbackQuery: (other) => ctx.answerCallbackQuery(other),
  };
}

export const SERVER_UNRESPONSIVE_MESSAGE =
  "The game server didn't respond, even after retrying for ~10 seconds — it may be rate-limiting queries " +
  'or offline. Try again in a moment.';

/**
 * RCON gave up (UDP, all retries timed out — see rcon-client's udp-transport.ts). Without this the
 * command just silently does nothing from the user's point of view; a button press also stays
 * stuck on its loading spinner until the callback query is answered.
 */
async function notifyServerUnresponsive(ctx: Context): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({
      text: SERVER_UNRESPONSIVE_MESSAGE,
      show_alert: true,
    });
  } else if (ctx.chat) {
    await ctx.reply(SERVER_UNRESPONSIVE_MESSAGE);
  }
}

export function createBot(
  config: GatewayConfig,
  deps: GatewayDeps,
  claimSecret: string,
): Bot {
  const { router } = deps.telegramRoutes;
  const bot = new Bot(config.telegramBotToken, {
    client: {
      // Every request goes to the current route — direct or a relay (telegram-routes.ts).
      buildUrl: router.buildUrl,
      // A fresh connection per request: Russian ISPs cut connections to Cloudflare (one of the
      // relay platforms) after 16 KB, which a reused connection would eventually hit. With one long
      // poll every ~30s, the extra handshakes cost nothing noticeable.
      baseFetchConfig: { agent: new Agent({ keepAlive: false }) },
    },
  });
  bot.api.config.use(
    failoverTransformer(router, (root) =>
      probeRoute(root, config.telegramBotToken),
    ),
  );

  const staff = requireStaff(deps.adminStore);
  const allow = (permission: Permission) =>
    requirePermission(permission, deps.adminStore);

  bot.command('start', (ctx) => mcpStart(ctx, deps));
  bot.command('claim', (ctx) => claimCommand(ctx, deps, claimSecret));
  bot.command('help', (ctx) => helpCommand(ctx, deps));
  bot.command('help_ru', (ctx) => helpRuCommand(ctx, deps));

  bot.command('mcp', staff, (ctx) => mcpCommand(ctx, deps));
  bot.command('app', staff, (ctx) =>
    appCommand(ctx, config.miniapp.url, bot.botInfo.username),
  );
  bot.command('status', staff, (ctx) => statusCommand(ctx, deps));
  bot.command('players', staff, (ctx) => playersCommand(ctx, deps));
  bot.command('servers', staff, (ctx) => serversCommand(ctx, deps));

  bot.command('kick', allow('kick'), (ctx) => kickCommand(ctx, deps));
  bot.command('tempban', allow('tempban'), (ctx) => tempbanCommand(ctx, deps));
  bot.command('ban', allow('ban'), (ctx) => banCommand(ctx, deps));
  bot.command('unban', allow('ban'), (ctx) => unbanCommand(ctx, deps));
  bot.command('bans', allow('ban'), (ctx) => bansCommand(ctx, deps));
  bot.command('map', allow('maps'), (ctx) => mapCommand(ctx, deps));
  bot.command('maps', allow('maps'), (ctx) => mapsCommand(ctx, deps));
  bot.command('say', allow('say'), (ctx) => sayCommand(ctx, deps));
  bot.command('bindserver', allow('servers.assign'), (ctx) =>
    bindServerCommand(ctx, deps),
  );
  bot.command('setdefault', allow('servers.assign'), (ctx) =>
    setDefaultCommand(ctx, deps),
  );
  bot.command('addadmin', allow('admins.manage'), (ctx) =>
    addAdminCommand(withReplyToUserId(ctx), deps),
  );
  bot.command('removeadmin', allow('admins.manage'), (ctx) =>
    removeAdminCommand(withReplyToUserId(ctx), deps),
  );
  bot.command('permit', allow('admins.manage'), (ctx) =>
    permitCommand(withReplyToUserId(ctx), deps),
  );
  bot.command('listadmins', allow('admins.manage'), (ctx) =>
    listAdminsCommand(ctx, deps),
  );

  bot.command('auditlog', allow('audit'), (ctx) => auditLogCommand(ctx, deps));
  bot.command('rcon', allow('rcon'), (ctx) => rconCommand(ctx, deps));
  bot.command('update', allow('update'), (ctx) => updateCommand(ctx, deps));
  bot.command('addserver', allow('servers.manage'), (ctx) =>
    addServerCommand(ctx, deps),
  );
  bot.command('removeserver', allow('servers.manage'), (ctx) =>
    removeServerCommand(ctx, deps),
  );
  bot.command('findlog', allow('logs'), (ctx) =>
    findLogCommand(ctx, deps, {
      startTailer: (server) => {
        startReportTailer(server, deps, bot, config.textEncoding);
      },
      decode: (bytes) => decodeText(bytes, config.textEncoding),
    }),
  );
  bot.command('relays', allow('relays'), (ctx) => relaysCommand(ctx, deps));
  bot.command('templates', allow('templates'), (ctx) =>
    templatesCommand(ctx, deps),
  );
  bot.command('vpnnets', allow('vpn'), (ctx) => vpnNetsCommand(ctx, deps));
  bot.command('vpnkick', allow('vpn'), (ctx) => vpnKickCommand(ctx, deps));
  bot.command('known', allow('vpn'), (ctx) => knownCommand(ctx, deps));
  bot.command('watch', allow('watch.manage'), (ctx) => watchCommand(ctx, deps));

  bot.callbackQuery(/^mcp:(?:allow|read|deny):[0-9a-f]{32}$/, staff, (ctx) => {
    const actor = ctx as Context & BotContext;
    if (!actor.from || !actor.admin || !actor.callbackQuery?.data) {
      return;
    }
    return mcpDecision(
      {
        fromId: actor.from.id,
        admin: actor.admin,
        data: actor.callbackQuery.data,
        privateChat: actor.chat?.type === 'private' || actor.chat === undefined,
        answer: (text) => actor.answerCallbackQuery({ text }),
        edit: (text) => actor.editMessageText(text),
      },
      deps,
    );
  });
  bot.callbackQuery(STATUS_REFRESH_CALLBACK_DATA, staff, (ctx) =>
    statusRefreshCallback(ctx, deps),
  );
  bot.callbackQuery(/^map(ask|no)?:/, allow('maps'), (ctx) =>
    mapsSelectCallback(toMapsCallbackContext(ctx), deps),
  );
  bot.callbackQuery(/^update:/, allow('update'), (ctx) =>
    updateActionCallback(toUpdateCallbackContext(ctx), deps),
  );
  bot.callbackQuery(/^report:/, staff, (ctx) =>
    reportActionCallback(toReportCallbackContext(ctx), {
      bot,
      registry: deps.reportRegistry,
      antiSpam: deps.reportAntiSpam,
      rconClients: deps.rconClients,
      adminStore: deps.adminStore,
      banStore: deps.banStore,
      sessionsByServer: deps.sessionsByServer,
      reportQueue: deps.reportQueue,
      chatTemplates: deps.chatTemplates,
      describeIp: (ip) =>
        joinIpLabels(
          joinCountryAndProvider(
            describeIpLong(deps.geoip, ip),
            describeProviderLong(deps.provider, ip),
          ),
          describeVpnLong(deps.vpn, ip),
        ),
    }),
  );

  bot.catch(async ({ error, ctx }) => {
    console.error(
      `Gateway bot error handling update ${ctx.update.update_id}:`,
      error,
    );
    // The one failure worth telling the user about: everything else stays log-only, as before.
    if (error instanceof UdpQueryTimeoutError) {
      await notifyServerUnresponsive(ctx).catch((notifyError: unknown) => {
        console.error(
          'Gateway bot failed to report an unresponsive server:',
          notifyError,
        );
      });
    }
  });

  return bot;
}
