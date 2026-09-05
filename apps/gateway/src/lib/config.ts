/**
 * Phase 2 config (docs/PLAN.md §9): admin-store/ban-store on Postgres, roles instead of a
 * single hardcoded owner check, multi-server via the `servers` table. `ownerTelegramId` is now
 * optional — the owner can also be established via `/claim` (§4) if the env var isn't set.
 * `rcon`/`serverAlias` seed the one `servers` row the gateway bootstraps on first startup.
 */
export interface GatewayConfig {
  telegramBotToken: string;
  ownerTelegramId: number | undefined;
  databaseUrl: string;
  secretsEncryptionKey: string;
  serverAlias: string;
  rcon: {
    host: string;
    port: number;
    password: string;
  };
}

class ConfigError extends Error {}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new ConfigError(`Missing required env var: ${key}`);
  }
  return value;
}

function optionalIntEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (!raw) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new ConfigError(`Env var ${key} must be an integer, got "${raw}"`);
  }
  return value;
}

function requireIntEnv(env: NodeJS.ProcessEnv, key: string): number {
  const raw = requireEnv(env, key);
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new ConfigError(`Env var ${key} must be an integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    telegramBotToken: requireEnv(env, 'TELEGRAM_BOT_TOKEN'),
    ownerTelegramId: optionalIntEnv(env, 'OWNER_TELEGRAM_ID'),
    databaseUrl: requireEnv(env, 'DATABASE_URL'),
    secretsEncryptionKey: requireEnv(env, 'SECRETS_ENCRYPTION_KEY'),
    serverAlias: env['COD2_SERVER_ALIAS']?.trim() || 'default',
    rcon: {
      host: requireEnv(env, 'COD2_RCON_HOST'),
      port: requireIntEnv(env, 'COD2_RCON_PORT'),
      password: requireEnv(env, 'COD2_RCON_PASSWORD'),
    },
  };
}
