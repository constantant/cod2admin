import { randomBytes } from 'node:crypto';
import { createAdminStore, migrate as migrateAdminStore } from '@cod2admin/admin-store';
import { createBanStore, migrate as migrateBanStore } from '@cod2admin/ban-store';
import { RconClient } from '@cod2admin/rcon-client';
import { ReportAntiSpam } from '@cod2admin/report-pipeline';
import type { SessionLookup } from '@cod2admin/report-pipeline';
import { createBot } from './lib/bot.js';
import { loadConfig } from './lib/config.js';
import type { GatewayDeps } from './lib/deps.js';
import { startExpiryPoller } from './lib/expiry-poller.js';
import { startReportTailers } from './lib/report-tailers.js';
import { ReportRegistry } from './lib/reports.js';

const config = loadConfig();

await migrateAdminStore(config.databaseUrl);
await migrateBanStore(config.databaseUrl);

const adminStore = createAdminStore(config.databaseUrl, config.secretsEncryptionKey);
const banStore = createBanStore(config.databaseUrl);

if (config.ownerTelegramId !== undefined) {
  const result = await adminStore.claimOwner(config.ownerTelegramId);
  if (result === 'claimed') {
    console.log(`Bootstrapped owner from OWNER_TELEGRAM_ID: ${config.ownerTelegramId}`);
  }
}

await adminStore.upsertServer({
  alias: config.serverAlias,
  rconHost: config.rcon.host,
  rconPort: config.rcon.port,
  rconPassword: config.rcon.password,
  logSourceConfig: config.logPath,
});

const servers = await adminStore.listServers();
const rconClients = new Map(
  servers.map((server) => [
    server.alias,
    new RconClient({ host: server.rconHost, port: server.rconPort, password: server.rconPassword }),
  ]),
);

const claimSecret = randomBytes(16).toString('hex');
console.log(`/claim secret (use this in Telegram if OWNER_TELEGRAM_ID wasn't set): ${claimSecret}`);

// Report-card state (docs/PLAN.md §5 steps 4/6) — process-lifetime, shared between the bot's
// callback handler and the GameLogTailer wiring below, so both sides see the same in-flight
// reports/cooldowns.
const deps: GatewayDeps = {
  adminStore,
  banStore,
  rconClients,
  reportRegistry: new ReportRegistry(),
  reportAntiSpam: new ReportAntiSpam<string>(),
  sessionsByServer: new Map<string, SessionLookup>(),
};

startExpiryPoller(deps);

const bot = createBot(config, deps, claimSecret);

startReportTailers(servers, deps, bot);

void bot.start({
  onStart: (botInfo) => {
    console.log(`cod2admin gateway started as @${botInfo.username}`);
  },
});
