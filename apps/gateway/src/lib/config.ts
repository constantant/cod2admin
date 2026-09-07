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
  /**
   * `games_mp.log` path for the bootstrapped server (docs/PLAN.md §5/§11.1's `COD2_LOG_PATH`) —
   * optional, since a deployment can run RCON-only without Phase 3's report automation.
   * Stored as that server's `logSourceConfig` (in the schema since Phase 2, unused until now).
   */
  logPath: string | undefined;
  /**
   * Self-update staging directory (docs/PLAN.md §13.5's `$STAGING_DIR`, written by `install.sh`'s
   * `write_env()`) — optional, since older installs and `nx serve` won't have it. Unset disables
   * the version-check poller and `/update` (§13.2/§13.3) entirely, same "gracefully off" pattern
   * `logPath` uses for report automation.
   */
  updateStagingDir: string | undefined;
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
    logPath: env['COD2_LOG_PATH']?.trim() || undefined,
    updateStagingDir: env['UPDATE_STAGING_DIR']?.trim() || undefined,
  };
}
