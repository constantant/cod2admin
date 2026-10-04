import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAdminStore, migrate as migrateAdminStore } from '@cod2admin/admin-store';
import { createBanStore, migrate as migrateBanStore } from '@cod2admin/ban-store';
import { RconClient } from '@cod2admin/rcon-client';
import { ReportAntiSpam } from '@cod2admin/report-pipeline';
import type { SessionLookup } from '@cod2admin/report-pipeline';
import { createBot } from './lib/bot.js';
import { loadConfig } from './lib/config.js';
import type { GatewayDeps, UpdateFeatureConfig } from './lib/deps.js';
import { startExpiryPoller } from './lib/expiry-poller.js';
import { GeoIpDatabase, GeoIpUpdater, NO_COUNTRY_LOOKUP } from './lib/geoip.js';
import {
  DEFAULT_TELEGRAM_RELAYS,
  describeRoute,
  parseRouteSettings,
  probeRoute,
  ROUTES_SETTING_KEY,
  routesFrom,
  selectWorkingRoute,
  startPreferredRouteCheck,
  TelegramRouter,
  type TelegramRouteSettings,
} from './lib/telegram-routes.js';
import { createGithubReleaseClient } from './lib/github-releases.js';
import { startReportTailers } from './lib/report-tailers.js';
import { ReportRegistry } from './lib/reports.js';
import { checkPendingUpdateOnBoot } from './lib/update-boot-check.js';
import { UpdateRegistry } from './lib/update-registry.js';
import { startVersionCheckPoller } from './lib/version-check-poller.js';

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

const createRconClient = (server: { host: string; port: number; password: string }) =>
  new RconClient({ ...server, encoding: config.textEncoding });

const servers = await adminStore.listServers();
const rconClients = new Map(
  servers.map((server) => [
    server.alias,
    createRconClient({ host: server.rconHost, port: server.rconPort, password: server.rconPassword }),
  ]),
);

const claimSecret = randomBytes(16).toString('hex');
console.log(`/claim secret (use this in Telegram if OWNER_TELEGRAM_ID wasn't set): ${claimSecret}`);

// Self-update (docs/PLAN.md §13.2/§13.3) — disabled (undefined) unless install.sh wrote
// UPDATE_STAGING_DIR (§13.5's $STAGING_DIR). applyUpdateScriptPath is derived, not a second env
// var: bin/ and staging/ are always siblings under $INSTALL_DIR by that layout.
const updateConfig: UpdateFeatureConfig | undefined = config.updateStagingDir
  ? {
      stagingDir: config.updateStagingDir,
      applyUpdateScriptPath: path.join(path.dirname(config.updateStagingDir), 'bin', 'apply-update.sh'),
    }
  : undefined;

// IP → country labels (lib/geoip.ts). The downloaded database goes in the staging dir: it's the
// one directory the service user can write to on a real install (install.sh makes the rest of
// $INSTALL_DIR root-owned), and apply-update.sh only ever deletes the release tarball it applied.
const geoipDatabase = new GeoIpDatabase();
if (config.geoip.enabled) {
  const geoipUpdater = new GeoIpUpdater({
    database: geoipDatabase,
    filePath:
      config.geoip.dbPath ?? path.join(config.updateStagingDir ?? tmpdir(), 'dbip-country-lite.mmdb'),
    autoDownload: config.geoip.dbPath === undefined,
  });
  // Not awaited: a slow or failed download must never delay the bot's start.
  void geoipUpdater.start();
}

// How the bot reaches Telegram (lib/telegram-routes.ts, docs/PLAN-russia-access.md): a /relays
// change stored in the database wins over .env, which wins over direct + the built-in relays.
const telegramDefaults: TelegramRouteSettings = {
  direct: config.telegram.direct,
  relays: config.telegram.relays ?? [...DEFAULT_TELEGRAM_RELAYS],
};
const telegramRouteSettings = parseRouteSettings(await adminStore.getSetting(ROUTES_SETTING_KEY)) ?? telegramDefaults;
const telegramRouter = new TelegramRouter(routesFrom(telegramRouteSettings));
const probeTelegramRoute = (root: string) => probeRoute(root, config.telegramBotToken);
const routeResults = await selectWorkingRoute(telegramRouter, probeTelegramRoute);
if ([...routeResults.values()].some((result) => result.ok)) {
  console.log(`Telegram: connecting via ${describeRoute(telegramRouter.current)}`);
} else {
  console.warn(
    'Telegram: no route reaches the Bot API right now (' +
      [...routeResults].map(([root, result]) => `${describeRoute(root)}: ${result.ok ? 'ok' : result.error}`).join('; ') +
      ') — retrying in the background. If this host is in Russia, see docs/PLAN-russia-access.md.',
  );
}
startPreferredRouteCheck(telegramRouter, probeTelegramRoute);

// Report-card state (docs/PLAN.md §5 steps 4/6) — process-lifetime, shared between the bot's
// callback handler and the GameLogTailer wiring below, so both sides see the same in-flight
// reports/cooldowns.
const deps: GatewayDeps = {
  adminStore,
  banStore,
  rconClients,
  createRconClient,
  bootstrapServerAlias: config.serverAlias,
  geoip: config.geoip.enabled ? geoipDatabase : NO_COUNTRY_LOOKUP,
  telegramRoutes: { router: telegramRouter, defaults: telegramDefaults, probe: probeTelegramRoute },
  reportRegistry: new ReportRegistry(),
  reportAntiSpam: new ReportAntiSpam<string>(),
  sessionsByServer: new Map<string, SessionLookup>(),
  updateConfig,
  githubReleaseClient: createGithubReleaseClient(),
  updateRegistry: new UpdateRegistry(),
};

startExpiryPoller(deps);

const bot = createBot(config, deps, claimSecret);

// Must run (and finish) before bot.start() - see checkPendingUpdateOnBoot's doc comment for why.
await checkPendingUpdateOnBoot(deps, bot);

startVersionCheckPoller(deps, bot);

startReportTailers(servers, deps, bot, config.textEncoding);

void bot.start({
  // Small batches keep each relay response well under 16 KB (see the Cloudflare note in bot.ts).
  limit: 10,
  onStart: (botInfo) => {
    console.log(`cod2admin gateway started as @${botInfo.username}`);
  },
});
