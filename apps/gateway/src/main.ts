import { RconClient } from '@cod2admin/rcon-client';
import { createBot } from './lib/bot.js';
import { loadConfig } from './lib/config.js';

const config = loadConfig();
const rcon = new RconClient(config.rcon);
const bot = createBot(config, rcon);

void bot.start({
  onStart: (botInfo) => {
    console.log(`cod2admin gateway started as @${botInfo.username}`);
  },
});
