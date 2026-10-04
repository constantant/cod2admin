/**
 * Phase 2 config (docs/PLAN.md §9): admin-store/ban-store on Postgres, roles instead of a
 * single hardcoded owner check, multi-server via the `servers` table. `ownerTelegramId` is now
 * optional — the owner can also be established via `/claim` (§4) if the env var isn't set.
 * `rcon`/`serverAlias` seed the one `servers` row the gateway bootstraps on first startup.
 */
import { TEXT_ENCODINGS, type TextEncoding } from '@cod2admin/rcon-client';
import { normalizeRelayUrl } from './telegram-routes.js';

/**
 * CP1251, not latin1: the game has no encoding of its own and shows bytes in the player's Windows
 * code page, and this bot's servers are Russian — a real one's player names and `say` text were
 * CP1251 (docs/PLAN.md §2.4, "Text encoding"). ASCII-only servers are unaffected either way.
 */
export const DEFAULT_TEXT_ENCODING: TextEncoding = 'cp1251';

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
  /** `COD2_TEXT_ENCODING` — how RCON text and the game log are encoded, for every server. */
  textEncoding: TextEncoding;
  /**
   * IP → country labels (geoip.ts). `GEOIP_ENABLED=false` turns them off. `GEOIP_DB_PATH` points at
   * a .mmdb the admin supplies themselves (e.g. a host that can't reach db-ip.com), which turns
   * off the automatic monthly download.
   */
  geoip: { enabled: boolean; dbPath: string | undefined };
  /**
   * Default routes to the Telegram Bot API (telegram-routes.ts, docs/PLAN-russia-access.md):
   * `TELEGRAM_DIRECT=false` skips api.telegram.org itself, `TELEGRAM_RELAYS` (comma-separated)
   * replaces the built-in shared relays. `/relays` changes both at runtime and takes precedence.
   */
  telegram: { direct: boolean; relays: string[] | undefined };
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

function textEncodingEnv(env: NodeJS.ProcessEnv): TextEncoding {
  const raw = env['COD2_TEXT_ENCODING']?.trim().toLowerCase();
  if (!raw) {
    return DEFAULT_TEXT_ENCODING;
  }
  const encoding = TEXT_ENCODINGS.find((candidate) => candidate === raw);
  if (!encoding) {
    throw new ConfigError(`Env var COD2_TEXT_ENCODING must be one of ${TEXT_ENCODINGS.join(', ')}, got "${raw}"`);
  }
  return encoding;
}

function telegramRoutesEnv(env: NodeJS.ProcessEnv): GatewayConfig['telegram'] {
  const direct = env['TELEGRAM_DIRECT']?.trim().toLowerCase() !== 'false';
  const raw = env['TELEGRAM_RELAYS']?.trim();
  const relays = raw
    ? raw.split(',').map((entry) => {
        const url = normalizeRelayUrl(entry);
        if (!url) {
          throw new ConfigError(`TELEGRAM_RELAYS entries must be https URLs, got "${entry.trim()}"`);
        }
        return url;
      })
    : undefined;
  if (!direct && !relays?.length) {
    throw new ConfigError('TELEGRAM_DIRECT=false needs at least one relay in TELEGRAM_RELAYS');
  }
  return { direct, relays };
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
    textEncoding: textEncodingEnv(env),
    telegram: telegramRoutesEnv(env),
    geoip: {
      enabled: env['GEOIP_ENABLED']?.trim().toLowerCase() !== 'false',
      dbPath: env['GEOIP_DB_PATH']?.trim() || undefined,
    },
  };
}
