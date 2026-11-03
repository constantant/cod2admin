import type { ServerConfig } from '@cod2admin/admin-store';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import {
  findGameLog,
  inspectLogFile,
  readLiveServerInfo,
} from '../find-game-log.js';
import {
  detectBotRuntime,
  logNotFoundHelp,
  unreadableLogHelp,
} from '../log-access-help.js';
import { stopReportTailer } from '../report-tailers.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';

const USAGE =
  'Usage: /findlog [--server <alias>] — search for the log\n' +
  '/findlog /path/to/games_mp.log — use this file\n' +
  '/findlog off — stop reading the log';

export interface FindLogEnv {
  /** Starts reading a server's log (`startReportTailer`, bound to the bot and its text encoding). */
  startTailer(server: ServerConfig): void;
  decode: (bytes: Buffer) => string;
}

async function audit(
  ctx: BotContext,
  deps: GatewayDeps,
  alias: string,
  path: string | null,
): Promise<void> {
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'setlogpath',
    target: path,
    serverAlias: alias,
    source: 'telegram_command',
  });
}

async function useLog(
  ctx: BotContext,
  deps: GatewayDeps,
  env: FindLogEnv,
  alias: string,
  path: string,
): Promise<void> {
  await deps.adminStore.setServerLogPath(alias, path);
  const server = await deps.adminStore.getServer(alias);
  stopReportTailer(alias, deps);
  if (server) {
    env.startTailer(server);
  }
  await audit(ctx, deps, alias, path);
  await ctx.reply(
    `Now reading the log of "${alias}":\n${path}\n\n` +
      (server?.boundTelegramChatId
        ? '!report cards go to the bound chat.'
        : `To get !report cards, run /bindserver ${alias} in your admins' group.`),
  );
}

/**
 * `/findlog [--server <alias>] [<path>|off]` — owner-only. Finds a server's `games_mp.log` on the
 * bot's machine and starts reading it, with no restart. See `findGameLog` for how it decides.
 */
export async function findLogCommand(
  ctx: BotContext,
  deps: GatewayDeps,
  env: FindLogEnv,
): Promise<void> {
  const { alias: flag, rest } = extractServerFlag(matchText(ctx));
  if (rest && rest !== 'off' && !rest.startsWith('/')) {
    await ctx.reply(USAGE);
    return;
  }
  const target = await resolveServer(ctx, deps, flag);
  if (!target) {
    return;
  }
  const { alias, rcon } = target;

  // main.ts saves COD2_LOG_PATH on every start, so a change made here wouldn't survive a restart.
  if (alias === deps.bootstrapServerAlias && deps.bootstrapLogPath) {
    await ctx.reply(
      `The log of "${alias}" is set in the bot's config file:\n${deps.bootstrapLogPath}\n\n` +
        'To let /findlog manage it, remove COD2_LOG_PATH from .env and restart the bot.',
    );
    return;
  }

  if (rest === 'off') {
    await deps.adminStore.setServerLogPath(alias, null);
    stopReportTailer(alias, deps);
    await audit(ctx, deps, alias, null);
    await ctx.reply(`Stopped reading the log of "${alias}".`);
    return;
  }

  if (rest) {
    const live = await readLiveServerInfo(rcon);
    const verdict = await inspectLogFile(rest, live, env.decode);
    if (verdict === 'current' || verdict === 'same-name') {
      await useLog(ctx, deps, env, alias, rest);
      return;
    }
    if (verdict === 'unreadable') {
      await ctx.reply(unreadableLogHelp([rest], detectBotRuntime()));
      return;
    }
    const problems = {
      missing: 'There is no such file. Check the path.',
      'not-a-log':
        "That file has no map start (InitGame) line, so it isn't a CoD2 game log, or the server hasn't started a map since it was created.",
      'other-server': `That's not the log of "${alias}": its latest map start has a different server name.`,
    };
    await ctx.reply(`Nothing was changed. ${problems[verdict]}`);
    return;
  }

  await ctx.reply(`Looking for the log of "${alias}"… (can take up to ~30 seconds)`);
  const result = await findGameLog(rcon, { decode: env.decode });

  if (result.log) {
    await useLog(ctx, deps, env, alias, result.log);
    return;
  }

  const runtime = detectBotRuntime();
  const notes: string[] = [];
  if (result.possible.length > 0) {
    notes.push(
      `These could be it, but I can't tell for sure. Pick one with /findlog <path>:\n${result.possible.join('\n')}`,
    );
  } else if (result.loggingOff) {
    notes.push(
      'The server has logging turned off. Set g_log "games_mp.log" in its config and restart it, then try again.',
    );
  } else if (result.unreadable.length === 0) {
    notes.push(logNotFoundHelp(alias, result.reportedPath, runtime));
  }
  if (result.unreadable.length > 0) {
    notes.push(unreadableLogHelp(result.unreadable, runtime));
  }
  // Only when there's nothing to act on above: otherwise it reads as if the search failed.
  if (
    !result.complete &&
    result.possible.length === 0 &&
    result.unreadable.length === 0
  ) {
    notes.push(
      'The search stopped before covering the whole disk. If you know the path, use /findlog <path>.',
    );
  }
  await ctx.reply(notes.join('\n\n'));
}
