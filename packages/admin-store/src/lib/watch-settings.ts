import type { ServerWatchSettings, WatchJoin, WatchMode } from './types.js';

export class WatchSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchSettingsError';
  }
}

/** Base for the first settings write. A null column stays off and opens nothing. */
export const DEFAULT_SERVER_WATCH_SETTINGS: ServerWatchSettings = {
  enabled: false,
  mode: 'off',
  flagZ: 4,
  kickZ: 6,
  minFeatureN: 5000,
  minSelfLives: 8,
  kickExtremeLives: 3,
  kickMinSessionLives: 3,
  cooldownMs: 30 * 60 * 1000,
  maxKicksPerHour: 2,
  maxCardsPerHour: 10,
  spectatorName: 'AdminWatch',
  join: 'spectator',
  privateClientsPrevious: null,
  negotiatedProtocol: null,
  confirmedAimFeatures: 0,
};

const MODES = new Set<WatchMode>(['off', 'flag', 'report', 'kick']);
const JOINS = new Set<WatchJoin>(['spectator', 'private']);

/** Keys that must never land in `servers.watch`. The secret has its own column. */
const SECRET_KEYS = [
  'password',
  'privatePassword',
  'watchPrivatePassword',
  'sv_privatepassword',
] as const;

function requiredNumber(
  value: unknown,
  name: string,
  integer: boolean,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WatchSettingsError(`${name} must be a number.`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new WatchSettingsError(`${name} must be a whole number.`);
  }
  if (value < 0) {
    throw new WatchSettingsError(`${name} cannot be negative.`);
  }
  return value;
}

function optionalInt(value: unknown, name: string): number | null {
  if (value === null) {
    return null;
  }
  return requiredNumber(value, name, true);
}

/**
 * The object written to `servers.watch`. Copies known fields only.
 * Kick stays refused until two aim features are confirmed.
 */
export function watchSettingsForStorage(
  input: ServerWatchSettings,
): ServerWatchSettings {
  const raw = input as unknown as Record<string, unknown>;
  for (const key of SECRET_KEYS) {
    if (raw[key] != null && raw[key] !== '') {
      throw new WatchSettingsError(
        'The private password is not stored in watch settings.',
      );
    }
  }
  if (!MODES.has(input.mode)) {
    throw new WatchSettingsError(`Unknown watch mode: ${String(input.mode)}.`);
  }
  if (!JOINS.has(input.join)) {
    throw new WatchSettingsError(`Unknown watch join: ${String(input.join)}.`);
  }
  if (typeof input.enabled !== 'boolean') {
    throw new WatchSettingsError('enabled must be true or false.');
  }
  const confirmed = input.confirmedAimFeatures;
  if (confirmed !== 0 && confirmed !== 1 && confirmed !== 2) {
    throw new WatchSettingsError('confirmedAimFeatures must be 0, 1, or 2.');
  }
  if (input.mode === 'kick' && confirmed !== 2) {
    throw new WatchSettingsError('Kick mode needs confirmedAimFeatures 2.');
  }
  const name = input.spectatorName;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 32) {
    throw new WatchSettingsError('spectatorName must be 1-32 characters.');
  }
  return {
    enabled: input.enabled,
    mode: input.mode,
    flagZ: requiredNumber(input.flagZ, 'flagZ', false),
    kickZ: requiredNumber(input.kickZ, 'kickZ', false),
    minFeatureN: requiredNumber(input.minFeatureN, 'minFeatureN', true),
    minSelfLives: requiredNumber(input.minSelfLives, 'minSelfLives', true),
    kickExtremeLives: requiredNumber(
      input.kickExtremeLives,
      'kickExtremeLives',
      true,
    ),
    kickMinSessionLives: requiredNumber(
      input.kickMinSessionLives,
      'kickMinSessionLives',
      true,
    ),
    cooldownMs: requiredNumber(input.cooldownMs, 'cooldownMs', true),
    maxKicksPerHour: requiredNumber(
      input.maxKicksPerHour,
      'maxKicksPerHour',
      true,
    ),
    maxCardsPerHour: requiredNumber(
      input.maxCardsPerHour,
      'maxCardsPerHour',
      true,
    ),
    spectatorName: name,
    join: input.join,
    privateClientsPrevious: optionalInt(
      input.privateClientsPrevious,
      'privateClientsPrevious',
    ),
    negotiatedProtocol: optionalInt(
      input.negotiatedProtocol,
      'negotiatedProtocol',
    ),
    confirmedAimFeatures: confirmed,
  };
}
