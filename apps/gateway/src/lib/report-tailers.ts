import type { ServerConfig } from '@cod2admin/admin-store';
import { GameLogTailer, type ReportTrigger } from '@cod2admin/log-tailer';
import { decodeText, type TextEncoding } from '@cod2admin/rcon-client';
import type { Bot } from 'grammy';
import { DEFAULT_TEXT_ENCODING } from './config.js';
import type { GatewayDeps } from './deps.js';
import {
  describeIpLong,
  describeProviderLong,
  joinCountryAndProvider,
} from './geoip.js';
import { describeVpnLong, joinIpLabels } from './vpn-ranges.js';
import { handleReportTrigger } from './reports.js';

/**
 * Starts a `GameLogTailer` for every configured server that has a log path
 * (`ServerConfig.logSourceConfig` — from `COD2_LOG_PATH` or `/findlog`) and registers it
 * in `deps.logTailers` (the Mini App's live chat, docs/PLAN-miniapp.md §6.2) and
 * `deps.sessionsByServer` (the report card's `select` button re-enriches against it).
 *
 * `!report` automation (docs/PLAN.md §5) also needs a bound admin chat (`/bindserver`) to deliver
 * cards to: without one, a `reportTrigger` event is dropped. Returns the started tailers so a caller that wants to shut them down later can.
 *
 * A server missing either prerequisite gets a warning, not an error — RCON-only operation (no
 * report automation) is a valid, supported configuration.
 */
export function startReportTailers(
  servers: readonly ServerConfig[],
  deps: GatewayDeps,
  bot: Bot,
  textEncoding: TextEncoding = DEFAULT_TEXT_ENCODING,
): GameLogTailer[] {
  return servers
    .map((server) => startReportTailer(server, deps, bot, textEncoding))
    .filter((tailer): tailer is GameLogTailer => tailer !== undefined);
}

/** Starts reading one server's log — at startup, or when `/findlog` sets it while the bot runs. */
export function startReportTailer(
  server: ServerConfig,
  deps: GatewayDeps,
  bot: Bot,
  textEncoding: TextEncoding = DEFAULT_TEXT_ENCODING,
): GameLogTailer | undefined {
  const alias = server.alias;
  const logPath = server.logSourceConfig;
  if (!logPath) {
    console.warn(
      `Server "${alias}": no log path configured (COD2_LOG_PATH or /findlog) — !report automation disabled for it.`,
    );
    return undefined;
  }
  if (!deps.rconClients.has(alias)) {
    return undefined; // rconClients is built from this same server list, so this shouldn't happen
  }

  // Same encoding as the RCON client, so log names match `rcon status` names (§5.3).
  const tailer = new GameLogTailer({
    logPath,
    decode: (bytes) => decodeText(bytes, textEncoding),
  });
  deps.sessionsByServer.set(alias, tailer);
  deps.logTailers.set(alias, tailer);

  if (!server.boundTelegramChatId) {
    console.warn(
      `Server "${alias}": no bound Telegram chat (/bindserver) — !report automation disabled for it.`,
    );
  }

  const onReport = async (trigger: ReportTrigger): Promise<void> => {
    // Looked up per report: /bindserver and /addserver can change these while the bot runs.
    const chatId = (await deps.adminStore.getServer(alias))?.boundTelegramChatId;
    const rcon = deps.rconClients.get(alias);
    if (!chatId || !rcon) {
      return;
    }
    await handleReportTrigger(trigger, {
      bot,
      registry: deps.reportRegistry,
      antiSpam: deps.reportAntiSpam,
      serverAlias: alias,
      chatId,
      rcon,
      sessions: tailer,
      adminStore: deps.adminStore,
      banStore: deps.banStore,
      describeIp: (ip) =>
        joinIpLabels(
          joinCountryAndProvider(
            describeIpLong(deps.geoip, ip),
            describeProviderLong(deps.provider, ip),
          ),
          describeVpnLong(deps.vpn, ip),
        ),
    });
  };
  tailer.on('reportTrigger', (trigger) => {
    onReport(trigger).catch((error: unknown) => {
      console.error(
        `Failed to handle a !report trigger for server "${alias}":`,
        error,
      );
    });
  });
  tailer.on('error', (error) => {
    console.error(
      `GameLogTailer error for server "${alias}" (${logPath}):`,
      error,
    );
  });

  tailer.start().catch((error: unknown) => {
    console.error(
      `Failed to start log-tailing for server "${alias}" (${logPath}):`,
      error,
    );
  });
  return tailer;
}

/** Stops reading a server's log, if the bot is reading it. */
export function stopReportTailer(alias: string, deps: GatewayDeps): void {
  deps.logTailers.get(alias)?.stop();
  deps.logTailers.delete(alias);
  deps.sessionsByServer.delete(alias);
}
