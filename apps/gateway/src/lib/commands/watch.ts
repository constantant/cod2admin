import {
  DEFAULT_SERVER_WATCH_SETTINGS,
  WatchSettingsError,
  type ServerConfig,
  type ServerWatchSettings,
  type WatchJoin,
  type WatchMode,
} from '@cod2admin/admin-store';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';

export const WATCH_USAGE = [
  "/watch — show this server's watcher (nothing stored means off)",
  '/watch on | off',
  '/watch mode off|flag|report|kick',
  '/watch join spectator|private',
  '/watch set <key> <value>',
  '/watch password — private chat only; the secret is not saved in the audit log',
  '/watch unreserve — record giving the private slot back (no game command yet)',
  'Keys: enabled, mode, join, spectatorName, confirmedAimFeatures, flagZ, kickZ,',
  'minFeatureN, minSelfLives, kickExtremeLives, kickMinSessionLives, cooldownMs,',
  'maxKicksPerHour, maxCardsPerHour, privateClientsPrevious, negotiatedProtocol.',
  'Add --server <alias> to pick a server.',
].join('\n');

const NUMBER_KEYS = [
  'flagZ',
  'kickZ',
  'minFeatureN',
  'minSelfLives',
  'kickExtremeLives',
  'kickMinSessionLives',
  'cooldownMs',
  'maxKicksPerHour',
  'maxCardsPerHour',
] as const;

type NumberKey = (typeof NUMBER_KEYS)[number];

function isNumberKey(key: string): key is NumberKey {
  return (NUMBER_KEYS as readonly string[]).includes(key);
}

function formatWatch(server: ServerConfig): string {
  const watch = server.watch;
  if (!watch) {
    return [
      `${server.alias}: watcher is off. Nothing is stored.`,
      '',
      WATCH_USAGE,
    ].join('\n');
  }
  const password = server.watchPrivatePassword
    ? server.watchPrivatePasswordOwned
      ? 'set (generated for this bot)'
      : 'set (already on the server)'
    : 'not set';
  return [
    `${server.alias}: ${watch.enabled ? 'enabled' : 'disabled'}, mode ${watch.mode}, join ${watch.join}`,
    `confirmedAimFeatures ${watch.confirmedAimFeatures}, name ${watch.spectatorName}`,
    `flagZ ${watch.flagZ}, kickZ ${watch.kickZ}, minFeatureN ${watch.minFeatureN}, minSelfLives ${watch.minSelfLives}`,
    `kickExtremeLives ${watch.kickExtremeLives}, kickMinSessionLives ${watch.kickMinSessionLives}`,
    `cooldownMs ${watch.cooldownMs}, maxKicksPerHour ${watch.maxKicksPerHour}, maxCardsPerHour ${watch.maxCardsPerHour}`,
    `privateClientsPrevious ${watch.privateClientsPrevious ?? 'none'}, protocol ${watch.negotiatedProtocol ?? 'none'}`,
    `private password: ${password}`,
    '',
    WATCH_USAGE,
  ].join('\n');
}

function parseMode(value: string): WatchMode {
  if (
    value === 'off' ||
    value === 'flag' ||
    value === 'report' ||
    value === 'kick'
  ) {
    return value;
  }
  throw new WatchSettingsError('mode is off, flag, report, or kick.');
}

function parseJoin(value: string): WatchJoin {
  if (value === 'spectator' || value === 'private') {
    return value;
  }
  throw new WatchSettingsError('join is spectator or private.');
}

function parseBool(value: string): boolean {
  if (value === 'on' || value === 'true') {
    return true;
  }
  if (value === 'off' || value === 'false') {
    return false;
  }
  throw new WatchSettingsError('enabled is on or off.');
}

function parseNumber(raw: string, integer: boolean): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    throw new WatchSettingsError(`Expected a number, got "${raw}".`);
  }
  const value = Number(raw);
  if (integer && !Number.isInteger(value)) {
    throw new WatchSettingsError(`Expected a whole number, got "${raw}".`);
  }
  return value;
}

function parseOptionalInt(raw: string): number | null {
  if (raw === 'none' || raw === 'null') {
    return null;
  }
  return parseNumber(raw, true);
}

function parseConfirmed(raw: string): 0 | 1 | 2 {
  if (raw === '0' || raw === '1' || raw === '2') {
    return Number(raw) as 0 | 1 | 2;
  }
  throw new WatchSettingsError('confirmedAimFeatures is 0, 1, or 2.');
}

function withKey(
  base: ServerWatchSettings,
  key: string,
  value: string,
): ServerWatchSettings {
  if (!value) {
    throw new WatchSettingsError(`Usage: /watch set ${key} <value>`);
  }
  switch (key) {
    case 'enabled':
      return { ...base, enabled: parseBool(value) };
    case 'mode':
      return { ...base, mode: parseMode(value) };
    case 'join':
      return { ...base, join: parseJoin(value) };
    case 'spectatorName':
      return { ...base, spectatorName: value };
    case 'confirmedAimFeatures':
      return { ...base, confirmedAimFeatures: parseConfirmed(value) };
    case 'privateClientsPrevious':
      return { ...base, privateClientsPrevious: parseOptionalInt(value) };
    case 'negotiatedProtocol':
      return { ...base, negotiatedProtocol: parseOptionalInt(value) };
    default:
      break;
  }
  if (!isNumberKey(key)) {
    throw new WatchSettingsError(`Unknown setting "${key}".`);
  }
  const integer = key !== 'flagZ' && key !== 'kickZ';
  return { ...base, [key]: parseNumber(value, integer) };
}

async function audit(
  ctx: BotContext,
  deps: GatewayDeps,
  alias: string,
  action: string,
  detail: unknown,
): Promise<void> {
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action,
    serverAlias: alias,
    source: 'telegram_command',
    detailJson: detail,
  });
}

async function writeSettings(
  ctx: BotContext,
  deps: GatewayDeps,
  server: ServerConfig,
  next: ServerWatchSettings,
): Promise<void> {
  let saved = false;
  try {
    saved = await deps.adminStore.setServerWatch(server.alias, next);
  } catch (error) {
    if (error instanceof WatchSettingsError) {
      await ctx.reply(error.message);
      return;
    }
    throw error;
  }
  if (!saved) {
    await ctx.reply(`Unknown server "${server.alias}".`);
    return;
  }
  await audit(ctx, deps, server.alias, 'watch_settings', next);
  await ctx.reply(formatWatch({ ...server, watch: next }));
}

/**
 * `/watch` — read and write one server's watcher settings.
 * Does not open a game connection. `/watch password` is a private chat only.
 */
export async function watchCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  const { alias: serverAlias, rest } = extractServerFlag(matchText(ctx));
  const resolved = await resolveServer(ctx, deps, serverAlias);
  if (!resolved) {
    return;
  }
  const server = await deps.adminStore.getServer(resolved.alias);
  if (!server) {
    await ctx.reply(`Unknown server "${resolved.alias}".`);
    return;
  }

  const [subcommand = '', ...tokens] = rest.split(/\s+/).filter(Boolean);
  const sub = subcommand.toLowerCase();
  const base = server.watch ?? { ...DEFAULT_SERVER_WATCH_SETTINGS };

  try {
    switch (sub) {
      case '': {
        await ctx.reply(formatWatch(server));
        return;
      }
      case 'on':
      case 'off': {
        if (sub === 'off' && !server.watch) {
          await ctx.reply(formatWatch(server));
          return;
        }
        await writeSettings(ctx, deps, server, {
          ...base,
          enabled: sub === 'on',
        });
        return;
      }
      case 'mode': {
        await writeSettings(ctx, deps, server, {
          ...base,
          mode: parseMode(tokens[0]?.toLowerCase() ?? ''),
        });
        return;
      }
      case 'join': {
        await writeSettings(ctx, deps, server, {
          ...base,
          join: parseJoin(tokens[0]?.toLowerCase() ?? ''),
        });
        return;
      }
      case 'set': {
        const key = tokens[0] ?? '';
        const value = tokens.slice(1).join(' ');
        if (!key) {
          await ctx.reply(WATCH_USAGE);
          return;
        }
        await writeSettings(ctx, deps, server, withKey(base, key, value));
        return;
      }
      case 'password': {
        await showPassword(ctx, deps, server, tokens.length > 0);
        return;
      }
      case 'unreserve': {
        await unreserve(ctx, deps, server);
        return;
      }
      default:
        await ctx.reply(WATCH_USAGE);
    }
  } catch (error) {
    if (error instanceof WatchSettingsError) {
      await ctx.reply(error.message);
      return;
    }
    throw error;
  }
}

async function showPassword(
  ctx: BotContext,
  deps: GatewayDeps,
  server: ServerConfig,
  extraArgs: boolean,
): Promise<void> {
  if (extraArgs) {
    await ctx.reply(
      'The private password is only shown, with /watch password, in a private chat.',
    );
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('The private password is only shown in a private chat.');
    return;
  }
  const secret = server.watchPrivatePassword;
  if (!secret) {
    await ctx.reply(`No private password is stored for ${server.alias}.`);
    return;
  }
  try {
    await ctx.reply(secret);
  } catch (error) {
    // The error's payload is the sendMessage body. Drop it before any log.
    dropReplyPayload(error);
    console.error(`Failed to send the private password for ${server.alias}.`);
    throw error;
  }
  await audit(ctx, deps, server.alias, 'watch_private_password_shown', {
    owned: server.watchPrivatePasswordOwned,
  });
}

function dropReplyPayload(error: unknown): void {
  if (error !== null && typeof error === 'object' && 'payload' in error) {
    delete (error as { payload?: unknown }).payload;
  }
}

async function unreserve(
  ctx: BotContext,
  deps: GatewayDeps,
  server: ServerConfig,
): Promise<void> {
  const watch = server.watch;
  if (!watch) {
    await ctx.reply(`${server.alias}: watcher is off. Nothing is reserved.`);
    return;
  }
  const reserved =
    watch.join === 'private' ||
    watch.privateClientsPrevious !== null ||
    server.watchPrivatePasswordOwned;
  if (!reserved) {
    await ctx.reply(`${server.alias}: nothing is reserved.`);
    return;
  }
  const previous =
    watch.privateClientsPrevious === null
      ? 'no saved sv_privateclients value'
      : `sv_privateclients back to ${watch.privateClientsPrevious}`;
  if (watch.join === 'spectator') {
    await ctx.reply(
      `${server.alias}: already set to give the private slot back (${previous}). The game server is updated when the watcher applies settings.`,
    );
    return;
  }
  // Join is the stored intent. The supervisor writes sv_privateclients later.
  const next: ServerWatchSettings = { ...watch, join: 'spectator' };
  const saved = await deps.adminStore.setServerWatch(server.alias, next);
  if (!saved) {
    await ctx.reply(`Unknown server "${server.alias}".`);
    return;
  }
  await audit(ctx, deps, server.alias, 'watch_unreserve', {
    join: 'spectator',
    privateClientsPrevious: watch.privateClientsPrevious,
    passwordOwned: server.watchPrivatePasswordOwned,
  });
  await ctx.reply(
    `${server.alias}: join is spectator (${previous}). The game server is updated when the watcher applies settings.`,
  );
}
