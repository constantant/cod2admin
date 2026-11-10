/** One enabled server on the child hello. `password` is omitted for spectators. */
export interface HelloServer {
  alias: string;
  host: string;
  port: number;
  spectatorName: string;
  protocol: number;
  gSpeed: number | null;
  password?: string;
  /** Real map name once known. A map line is a later rename, not this field. */
  mapName?: string;
}

export interface HelloMessage {
  type: 'hello';
  servers: HelloServer[];
}

export interface ReloadMessage {
  type: 'reload';
  servers: Array<Omit<HelloServer, 'password'>>;
}

export interface MapMessage {
  type: 'map';
  serverAlias: string;
  mapName: string | null;
}

/** The noted status is still this map. Held absences are disconnects. */
export interface ConfirmMessage {
  type: 'confirm';
  serverAlias: string;
  mapName: string | null;
}

export type ParentMessage =
  HelloMessage | ReloadMessage | MapMessage | ConfirmMessage;

const FEATURE_KEYS = [
  'snapOnAcquire',
  'firedWhileLookingAway',
  'viewErrorAtHit',
  'timeToDamageMs',
  'angularSpeedP95',
  'speedOverG',
] as const;

export type IpcFeature = (typeof FEATURE_KEYS)[number];

export interface LifeMessage {
  type: 'life';
  serverAlias: string;
  slot: number;
  endReason: 'death' | 'disconnect' | 'map';
  strippedName: string;
  startedAtMs: number;
  endedAtMs: number;
  features: Partial<Record<IpcFeature, number>>;
}

/** Reload never copies `password`, even if the caller still has it. */
export function reloadMessage(servers: readonly HelloServer[]): ReloadMessage {
  return {
    type: 'reload',
    servers: servers.map(stripPassword),
  };
}

export function parseParentMessage(line: string): ParentMessage | undefined {
  const value = parseObject(line);
  if (!value) {
    return undefined;
  }
  if (value['type'] === 'map') {
    return parseMap(value);
  }
  if (value['type'] === 'confirm') {
    return parseConfirm(value);
  }
  if (!Array.isArray(value['servers'])) {
    return undefined;
  }
  const servers: HelloServer[] = [];
  for (const entry of value['servers']) {
    const server = parseServer(entry);
    if (!server) {
      return undefined;
    }
    servers.push(server);
  }
  if (value['type'] === 'hello') {
    return { type: 'hello', servers };
  }
  if (value['type'] === 'reload') {
    return { type: 'reload', servers: servers.map(stripPassword) };
  }
  return undefined;
}

function parseMap(value: Record<string, unknown>): MapMessage | undefined {
  const named = parseNamedMap(value);
  if (!named) {
    return undefined;
  }
  return {
    type: 'map',
    serverAlias: named.serverAlias,
    mapName: named.mapName,
  };
}

function parseConfirm(
  value: Record<string, unknown>,
): ConfirmMessage | undefined {
  const named = parseNamedMap(value);
  if (!named) {
    return undefined;
  }
  return {
    type: 'confirm',
    serverAlias: named.serverAlias,
    mapName: named.mapName,
  };
}

function parseNamedMap(
  value: Record<string, unknown>,
): { serverAlias: string; mapName: string | null } | undefined {
  const serverAlias = text(value['serverAlias']);
  const mapName = value['mapName'];
  if (!serverAlias) {
    return undefined;
  }
  if (mapName === null) {
    return { serverAlias, mapName: null };
  }
  if (typeof mapName !== 'string') {
    return undefined;
  }
  const trimmed = mapName.trim();
  return { serverAlias, mapName: trimmed.length > 0 ? trimmed : null };
}

function stripPassword(server: HelloServer): Omit<HelloServer, 'password'> {
  const next: Omit<HelloServer, 'password'> = {
    alias: server.alias,
    host: server.host,
    port: server.port,
    spectatorName: server.spectatorName,
    protocol: server.protocol,
    gSpeed: server.gSpeed,
  };
  if (server.mapName) {
    next.mapName = server.mapName;
  }
  return next;
}

/**
 * A life result. `selfLives`, scores, and map names on the object are dropped:
 * the parent loads those itself.
 */
export function parseLifeMessage(line: string): LifeMessage | undefined {
  const value = parseObject(line);
  if (!value || value['type'] !== 'life') {
    return undefined;
  }
  const serverAlias = text(value['serverAlias']);
  const slot = value['slot'];
  const endReason = value['endReason'];
  const startedAtMs = value['startedAtMs'];
  const endedAtMs = value['endedAtMs'];
  if (
    !serverAlias ||
    typeof slot !== 'number' ||
    !Number.isInteger(slot) ||
    (endReason !== 'death' &&
      endReason !== 'disconnect' &&
      endReason !== 'map') ||
    typeof startedAtMs !== 'number' ||
    !Number.isFinite(startedAtMs) ||
    typeof endedAtMs !== 'number' ||
    !Number.isFinite(endedAtMs)
  ) {
    return undefined;
  }
  const features: LifeMessage['features'] = {};
  const raw = value['features'];
  if (raw !== null && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const key of FEATURE_KEYS) {
      const feature = record[key];
      if (typeof feature === 'number' && Number.isFinite(feature)) {
        features[key] = feature;
      }
    }
  }
  return {
    type: 'life',
    serverAlias,
    slot,
    endReason,
    strippedName: text(value['strippedName']) ?? '',
    startedAtMs,
    endedAtMs,
    features,
  };
}

function parseServer(value: unknown): HelloServer | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  const alias = text(entry['alias']);
  const host = text(entry['host']);
  const spectatorName = text(entry['spectatorName']);
  const port = entry['port'];
  const protocol = entry['protocol'];
  const gSpeed = entry['gSpeed'];
  if (
    !alias ||
    !host ||
    !spectatorName ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    typeof protocol !== 'number' ||
    !Number.isInteger(protocol) ||
    !(
      gSpeed === null ||
      (typeof gSpeed === 'number' && Number.isFinite(gSpeed))
    )
  ) {
    return undefined;
  }
  const server: HelloServer = {
    alias,
    host,
    port,
    spectatorName,
    protocol,
    gSpeed,
  };
  const password = entry['password'];
  if (typeof password === 'string' && password.length > 0) {
    server.password = password;
  }
  const mapName = entry['mapName'];
  if (typeof mapName === 'string' && mapName.trim().length > 0) {
    server.mapName = mapName.trim();
  }
  return server;
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
