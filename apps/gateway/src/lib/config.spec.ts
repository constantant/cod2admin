import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const VALID_ENV = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  DATABASE_URL: 'postgres://user:pw@127.0.0.1:5432/db',
  SECRETS_ENCRYPTION_KEY: 'base64key',
  COD2_RCON_HOST: '127.0.0.1',
  COD2_RCON_PORT: '28960',
  COD2_RCON_PASSWORD: 'secret',
};

describe('loadConfig', () => {
  it('parses a complete env into a typed config, defaulting the server alias', () => {
    expect(loadConfig(VALID_ENV)).toEqual({
      telegramBotToken: 'test-token',
      ownerTelegramId: undefined,
      databaseUrl: 'postgres://user:pw@127.0.0.1:5432/db',
      secretsEncryptionKey: 'base64key',
      serverAlias: 'default',
      rcon: { host: '127.0.0.1', port: 28960, password: 'secret' },
    });
  });

  it('parses OWNER_TELEGRAM_ID and COD2_SERVER_ALIAS when given', () => {
    const config = loadConfig({ ...VALID_ENV, OWNER_TELEGRAM_ID: '12345', COD2_SERVER_ALIAS: 'my-server' });
    expect(config.ownerTelegramId).toBe(12345);
    expect(config.serverAlias).toBe('my-server');
  });

  it.each(Object.keys(VALID_ENV))('throws when %s is missing', (missingKey) => {
    const env = { ...VALID_ENV, [missingKey]: undefined };
    expect(() => loadConfig(env)).toThrow(new RegExp(missingKey));
  });

  it('throws when OWNER_TELEGRAM_ID is given but not an integer', () => {
    expect(() => loadConfig({ ...VALID_ENV, OWNER_TELEGRAM_ID: 'not-a-number' })).toThrow(/OWNER_TELEGRAM_ID/);
  });

  it('throws when COD2_RCON_PORT is not an integer', () => {
    expect(() => loadConfig({ ...VALID_ENV, COD2_RCON_PORT: 'not-a-number' })).toThrow(/COD2_RCON_PORT/);
  });
});
