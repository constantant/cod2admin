/**
 * Phase 1 config: single hardcoded server via env vars, single owner-admin — no `servers`/
 * `admins` tables yet (those land in Phase 2, see docs/PLAN.md §9).
 */
export interface GatewayConfig {
  telegramBotToken: string;
  ownerTelegramId: number;
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
    ownerTelegramId: requireIntEnv(env, 'OWNER_TELEGRAM_ID'),
    rcon: {
      host: requireEnv(env, 'COD2_RCON_HOST'),
      port: requireIntEnv(env, 'COD2_RCON_PORT'),
      password: requireEnv(env, 'COD2_RCON_PASSWORD'),
    },
  };
}
