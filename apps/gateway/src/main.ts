import { randomBytes } from 'node:crypto';
import { createAdminStore, migrate as migrateAdminStore } from '@cod2admin/admin-store';
import { createBanStore, migrate as migrateBanStore } from '@cod2admin/ban-store';
import { RconClient } from '@cod2admin/rcon-client';
import { createBot } from './lib/bot.js';
import { loadConfig } from './lib/config.js';
import { startExpiryPoller } from './lib/expiry-poller.js';

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

startExpiryPoller({ adminStore, banStore, rconClients });

const bot = createBot(config, { adminStore, banStore, rconClients }, claimSecret);

void bot.start({
  onStart: (botInfo) => {
    console.log(`cod2admin gateway started as @${botInfo.username}`);
  },
});
