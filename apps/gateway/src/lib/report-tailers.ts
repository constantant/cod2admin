import type { ServerConfig } from '@cod2admin/admin-store';
import { GameLogTailer } from '@cod2admin/log-tailer';
import type { Bot } from 'grammy';
import type { GatewayDeps } from './deps.js';
import { handleReportTrigger } from './reports.js';

/**
 * Starts a `GameLogTailer` for every configured server that has both a log path
 * (`ServerConfig.logSourceConfig` — `COD2_LOG_PATH` for the bootstrapped server, in the schema
 * since Phase 2 but unused until now) and a bound admin chat (`/bindserver` — nowhere to deliver
 * a card without one). Wires each tailer's `reportTrigger` event to `handleReportTrigger()`
 * (docs/PLAN.md §5) and registers the tailer in `deps.sessionsByServer` so the report card's
 * `select` button can re-enrich against the same session state. Returns the started tailers so
 * a caller that wants to shut them down later can.
 *
 * A server missing either prerequisite is skipped with a warning, not an error — RCON-only
 * operation (no report automation) is a valid, supported configuration.
 */
export function startReportTailers(servers: readonly ServerConfig[], deps: GatewayDeps, bot: Bot): GameLogTailer[] {
  const tailers: GameLogTailer[] = [];

  for (const server of servers) {
    const logPath = server.logSourceConfig;
    if (!logPath) {
      console.warn(`Server "${server.alias}": no log path configured (COD2_LOG_PATH) — !report automation disabled for it.`);
      continue;
    }
    const chatId = server.boundTelegramChatId;
    if (!chatId) {
      console.warn(`Server "${server.alias}": no bound Telegram chat (/bindserver) — !report automation disabled for it.`);
      continue;
    }
    const rcon = deps.rconClients.get(server.alias);
    if (!rcon) {
      continue; // rconClients is built from this same server list, so this shouldn't happen
    }

    const tailer = new GameLogTailer({ logPath });
    deps.sessionsByServer.set(server.alias, tailer);

    tailer.on('reportTrigger', (trigger) => {
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
      }).catch((error: unknown) => {
        console.error(`Failed to handle a !report trigger for server "${server.alias}":`, error);
      });
    });
    tailer.on('error', (error) => {
      console.error(`GameLogTailer error for server "${server.alias}" (${logPath}):`, error);
    });

    tailer.start().catch((error: unknown) => {
      console.error(`Failed to start log-tailing for server "${server.alias}" (${logPath}):`, error);
    });
    tailers.push(tailer);
  }

  return tailers;
}
