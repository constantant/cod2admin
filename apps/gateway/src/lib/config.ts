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
   * off the automatic monthly download. `GEOIP_ASN_DB_PATH` does the same for the provider
   * (ASN) database. `GEOIP_CITY_ENABLED=true` swaps the country database for DB-IP's city one
   * (adds the city; ~120 MB of memory, so off by default) — `GEOIP_DB_PATH` then names a city file.
   */
  geoip: {
    enabled: boolean;
    city: boolean;
    dbPath: string | undefined;
    asnDbPath: string | undefined;
  };
  /** VPN/proxy/Tor flags (vpn-ranges.ts). `VPN_FLAG_ENABLED=false` turns them and their downloads off. */
  vpnFlag: { enabled: boolean };
  /**
   * Default routes to the Telegram Bot API (telegram-routes.ts, docs/PLAN-russia-access.md):
   * `TELEGRAM_DIRECT=false` skips api.telegram.org itself, `TELEGRAM_RELAYS` (comma-separated)
   * replaces the built-in shared relays. `/relays` changes both at runtime and takes precedence.
   */
  telegram: { direct: boolean; relays: string[] | undefined };
  /**
   * The Telegram Mini App (docs/PLAN-miniapp.md). Off unless `MINIAPP_PORT` is set. `host` is what
   * the HTTP server binds to — loopback by default, since an HTTPS proxy (Caddy, a tunnel) sits in
   * front (§3). `url` is the public HTTPS address: when set, the bot's menu button opens it.
   * `staticDir` overrides where the built web app is served from. `devTelegramId` is the local dev
   * loop's stand-in user (§11) — it lets requests without Telegram's signature through as that
   * user, so it must never be set on a real install.
   */
  miniapp: {
    port: number | undefined;
    host: string;
    url: string | undefined;
    staticDir: string | undefined;
    devTelegramId: number | undefined;
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

function optionalIntEnv(
  env: NodeJS.ProcessEnv,
  key: string,
): number | undefined {
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
    throw new ConfigError(
      `Env var COD2_TEXT_ENCODING must be one of ${TEXT_ENCODINGS.join(', ')}, got "${raw}"`,
    );
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
          throw new ConfigError(
            `TELEGRAM_RELAYS entries must be https URLs, got "${entry.trim()}"`,
          );
        }
        return url;
      })
    : undefined;
  if (!direct && !relays?.length) {
    throw new ConfigError(
      'TELEGRAM_DIRECT=false needs at least one relay in TELEGRAM_RELAYS',
    );
  }
  return { direct, relays };
}

function miniAppEnv(env: NodeJS.ProcessEnv): GatewayConfig['miniapp'] {
  const url = env['MINIAPP_URL']?.trim() || undefined;
  if (url && !/^https:\/\/[^\s/]+/.test(url)) {
    throw new ConfigError(
      `MINIAPP_URL must be an https URL (Telegram only opens Mini Apps over HTTPS), got "${url}"`,
    );
  }
  return {
    port: optionalIntEnv(env, 'MINIAPP_PORT'),
    host: env['MINIAPP_HOST']?.trim() || '127.0.0.1',
    url,
    staticDir: env['MINIAPP_STATIC_DIR']?.trim() || undefined,
    devTelegramId: optionalIntEnv(env, 'MINIAPP_DEV_TELEGRAM_ID'),
  };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
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
      city: env['GEOIP_CITY_ENABLED']?.trim().toLowerCase() === 'true',
      dbPath: env['GEOIP_DB_PATH']?.trim() || undefined,
      asnDbPath: env['GEOIP_ASN_DB_PATH']?.trim() || undefined,
    },
    vpnFlag: {
      enabled: env['VPN_FLAG_ENABLED']?.trim().toLowerCase() !== 'false',
    },
    miniapp: miniAppEnv(env),
  };
}
