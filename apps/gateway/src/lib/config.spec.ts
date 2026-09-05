import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const VALID_ENV = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  OWNER_TELEGRAM_ID: '12345',
  COD2_RCON_HOST: '127.0.0.1',
  COD2_RCON_PORT: '28960',
  COD2_RCON_PASSWORD: 'secret',
};

describe('loadConfig', () => {
  it('parses a complete env into a typed config', () => {
    expect(loadConfig(VALID_ENV)).toEqual({
      telegramBotToken: 'test-token',
      ownerTelegramId: 12345,
      rcon: { host: '127.0.0.1', port: 28960, password: 'secret' },
    });
  });

  it.each(Object.keys(VALID_ENV))('throws when %s is missing', (missingKey) => {
    const env = { ...VALID_ENV, [missingKey]: undefined };
    expect(() => loadConfig(env)).toThrow(new RegExp(missingKey));
  });

  it('throws when OWNER_TELEGRAM_ID is not an integer', () => {
    expect(() => loadConfig({ ...VALID_ENV, OWNER_TELEGRAM_ID: 'not-a-number' })).toThrow(/OWNER_TELEGRAM_ID/);
  });

  it('throws when COD2_RCON_PORT is not an integer', () => {
    expect(() => loadConfig({ ...VALID_ENV, COD2_RCON_PORT: 'not-a-number' })).toThrow(/COD2_RCON_PORT/);
  });
});
