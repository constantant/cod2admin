import type { ServerConfig } from '@cod2admin/admin-store';
import { GameLogTailer } from '@cod2admin/log-tailer';
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
 * (`ServerConfig.logSourceConfig` — `COD2_LOG_PATH` for the bootstrapped server) and registers it
 * in `deps.logTailers` (the Mini App's live chat, docs/PLAN-miniapp.md §6.2) and
 * `deps.sessionsByServer` (the report card's `select` button re-enriches against it).
 *
 * `!report` automation (docs/PLAN.md §5) also needs a bound admin chat (`/bindserver`) to deliver
 * cards to: only then is the tailer's `reportTrigger` event wired to `handleReportTrigger()`.
 * Returns the started tailers so a caller that wants to shut them down later can.
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
  const tailers: GameLogTailer[] = [];

  for (const server of servers) {
    const logPath = server.logSourceConfig;
    if (!logPath) {
      console.warn(
        `Server "${server.alias}": no log path configured (COD2_LOG_PATH) — !report automation disabled for it.`,
      );
      continue;
    }
    const rcon = deps.rconClients.get(server.alias);
    if (!rcon) {
      continue; // rconClients is built from this same server list, so this shouldn't happen
    }

    // Same encoding as the RCON client, so log names match `rcon status` names (§5.3).
    const tailer = new GameLogTailer({
      logPath,
      decode: (bytes) => decodeText(bytes, textEncoding),
    });
    deps.sessionsByServer.set(server.alias, tailer);
    deps.logTailers.set(server.alias, tailer);

    const chatId = server.boundTelegramChatId;
    if (!chatId) {
      console.warn(
        `Server "${server.alias}": no bound Telegram chat (/bindserver) — !report automation disabled for it.`,
      );
    }

    tailer.on('reportTrigger', (trigger) => {
      if (!chatId) {
        return;
      }
      handleReportTrigger(trigger, {
        bot,
        registry: deps.reportRegistry,
        antiSpam: deps.reportAntiSpam,
        serverAlias: server.alias,
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
      }).catch((error: unknown) => {
        console.error(
          `Failed to handle a !report trigger for server "${server.alias}":`,
          error,
        );
      });
    });
    tailer.on('error', (error) => {
      console.error(
        `GameLogTailer error for server "${server.alias}" (${logPath}):`,
        error,
      );
    });

    tailer.start().catch((error: unknown) => {
      console.error(
        `Failed to start log-tailing for server "${server.alias}" (${logPath}):`,
        error,
      );
    });
    tailers.push(tailer);
  }

  return tailers;
}
