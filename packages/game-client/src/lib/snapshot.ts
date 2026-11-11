import { decodeText, parseCvarBlock } from '@cod2admin/rcon-client';
import { BitMsg } from './bit-msg.js';
import {
  BIG_INFO_STRING,
  CLIENTNUM_BITS,
  CS_SCORES1,
  CS_SCORES2,
  CS_SERVERINFO,
  CS_SYSTEMINFO,
  ENTITYNUM_NONE,
  ET_PLAYER,
  FLOAT_INT_BIAS,
  GENTITYNUM_BITS,
  HUDELEM_BITS,
  HUDELEM_COORD_BIAS,
  MAX_CONFIGSTRINGS,
  MAX_HUDELEMS,
  MAX_OBJECTIVES,
  MAX_STRING_CHARS,
  OBJECTIVE_STATE_BITS,
  SVC_BASELINE,
  SVC_CONFIGSTRING,
  SVC_DOWNLOAD,
  SVC_EOF,
  SVC_GAMESTATE,
  SVC_NOP,
  SVC_SERVER_COMMAND,
  SVC_SNAPSHOT,
} from './constants.js';
import {
  CLIENT_FIELDS,
  ENTITY_FIELDS,
  HUD_FIELDS,
  OBJECTIVE_FIELDS,
  PLAYER_FIELDS,
  fieldIndex,
  type NetField,
} from './net-fields.js';

const floatBits = new DataView(new ArrayBuffer(4));

function bitsToFloat(bits: number): number {
  floatBits.setInt32(0, bits, true);
  return floatBits.getFloat32(0, true);
}

function floatToBits(value: number): number {
  floatBits.setFloat32(0, value, true);
  return floatBits.getInt32(0, true);
}

function shortToAngle(value: number): number {
  return value * (360 / 65536);
}

export interface EntityObservation {
  serverTimeMs: number;
  entityNum: number;
  eType: number;
  clientNum: number;
  origin: readonly [number, number, number];
  /** `pos.trDelta`. Present because the entity state always carries it. */
  velocity: readonly [number, number, number];
  viewangles: readonly [number, number, number];
  weapon: number;
}

export interface ParsedSnapshot {
  serverTimeMs: number;
  lastframe: number;
  snapFlags: number;
  players: EntityObservation[];
  clients: { clientIndex: number; team: number }[];
}

export interface ParsedMessage {
  lastClientCommand: number;
  serverCommands: { seq: number; text: string }[];
  configstrings: Map<number, string>;
  clientNum: number | null;
  checksumFeed: number | null;
  /** True only when this message contained `svc_gamestate`. The feed is also carried forward on later snapshots. */
  gamestate: boolean;
  serverId: number | null;
  snapshots: ParsedSnapshot[];
}

export type ParseFailure = {
  ok: false;
  reason: 'truncated' | 'framing';
  /** Commands read before the message failed. A pure drop can sit in front of a bad snapshot. */
  serverCommands: { seq: number; text: string }[];
};
export type ParseOk = { ok: true; message: ParsedMessage; state: ParseState };
export type ParseResult = ParseOk | ParseFailure;

export interface ParseState {
  baselines: Map<number, Int32Array>;
  entities: Map<number, Int32Array>;
  clients: Map<number, Int32Array>;
  playerState: Int32Array;
  configstrings: Map<number, string>;
  clientNum: number | null;
  checksumFeed: number | null;
}

export function emptyParseState(): ParseState {
  return {
    baselines: new Map(),
    entities: new Map(),
    clients: new Map(),
    playerState: new Int32Array(PLAYER_FIELDS.length),
    configstrings: new Map(),
    clientNum: null,
    checksumFeed: null,
  };
}

function readValue(msg: BitMsg, bits: number): number {
  const abs = Math.abs(bits);
  let value = 0;
  const partial = abs & 7;
  if (partial) value = msg.readBits(partial);
  for (let shift = partial; shift < abs; shift += 8) {
    const byte = msg.readByte();
    if (byte < 0) return 0;
    value = value | (byte << shift) | 0;
  }
  if (bits < 0 && abs > 0 && abs < 32 && value & (1 << (abs - 1))) {
    value = value | ~((1 << abs) - 1) | 0;
  }
  return value | 0;
}

/** Entity / hud / objective field. Extra zero-bit that playerstate does not use. */
function readDeltaField(
  msg: BitMsg,
  from: Int32Array,
  to: Int32Array,
  index: number,
  field: NetField,
): boolean {
  if (msg.readBit() === 0) {
    to[index] = from[index] ?? 0;
    return !msg.overflowed;
  }
  if (msg.overflowed) return false;
  if (field.bits === 0 || field.bits === -99) {
    if (msg.readBit() === 0) {
      to[index] = 0;
      return !msg.overflowed;
    }
    const bias = field.bits === 0 ? FLOAT_INT_BIAS : HUDELEM_COORD_BIAS;
    const partialBits = field.bits === 0 ? 5 : 2;
    const scale = field.bits === 0 ? 32 : 4;
    if (msg.readBit() === 0) {
      const low = msg.readBits(partialBits);
      const high = msg.readByte();
      if (high < 0 || msg.overflowed) return false;
      to[index] = floatToBits(scale * high + low - bias);
      return true;
    }
    to[index] = msg.readLong();
    return !msg.overflowed;
  }
  if (field.bits === -100) {
    if (msg.readBit() === 0) {
      to[index] = 0;
      return !msg.overflowed;
    }
    to[index] = floatToBits(shortToAngle(msg.readShort()));
    return !msg.overflowed;
  }
  if (msg.readBit() === 0) {
    to[index] = 0;
    return !msg.overflowed;
  }
  to[index] = readValue(msg, field.bits);
  return !msg.overflowed;
}

/** Playerstate field. No leading zero-bit on floats or integers. */
function readPlayerField(
  msg: BitMsg,
  from: Int32Array,
  to: Int32Array,
  index: number,
  field: NetField,
): boolean {
  if (msg.readBit() === 0) {
    to[index] = from[index] ?? 0;
    return !msg.overflowed;
  }
  if (field.bits === 0) {
    if (msg.readBit() === 0) {
      const low = msg.readBits(5);
      const high = msg.readByte();
      if (high < 0 || msg.overflowed) return false;
      to[index] = floatToBits(32 * high + low - FLOAT_INT_BIAS);
      return true;
    }
    to[index] = msg.readLong();
    return !msg.overflowed;
  }
  if (field.bits === -100) {
    if (msg.readBit() === 0) {
      to[index] = 0;
      return !msg.overflowed;
    }
    to[index] = floatToBits(shortToAngle(msg.readShort()));
    return !msg.overflowed;
  }
  to[index] = readValue(msg, field.bits);
  return !msg.overflowed;
}

function readDeltaStruct(
  msg: BitMsg,
  from: Int32Array,
  list: readonly NetField[],
): Int32Array | 'removed' | null {
  if (msg.readBit() !== 0) return msg.overflowed ? null : 'removed';
  if (msg.readBit() === 0) return msg.overflowed ? null : from.slice();
  const lc = msg.readByte();
  if (lc < 0 || lc > list.length || msg.overflowed) return null;
  const to = from.slice();
  for (let i = 0; i < lc; i++) {
    const field = list[i];
    if (!field || !readDeltaField(msg, from, to, i, field)) return null;
  }
  return to;
}

function readCString(msg: BitMsg, maxChars: number): string | null {
  const bytes: number[] = [];
  for (;;) {
    const c = msg.readByte();
    if (c < 0) return null;
    if (c === 0) break;
    if (bytes.length >= maxChars) return null;
    bytes.push(c === 0x25 ? 0x2e : c);
  }
  return decodeText(Buffer.from(bytes), 'cp1251');
}

function readPlayerstate(
  msg: BitMsg,
  from: Int32Array,
  protocol: number,
): Int32Array | null {
  const to = from.slice();
  const lc = msg.readByte();
  if (lc < 0 || lc > PLAYER_FIELDS.length) return null;
  for (let i = 0; i < lc; i++) {
    const field = PLAYER_FIELDS[i];
    if (!field || !readPlayerField(msg, from, to, i, field)) return null;
  }
  const protocol119 = protocol === 119;
  const statBits = protocol119 ? 5 : 6;
  if (msg.readBit() === 1) {
    const bits = msg.readBits(statBits);
    if (msg.overflowed) return null;
    if (bits & (1 << 0)) msg.readShort();
    if (bits & (1 << 1)) msg.readShort();
    if (bits & (1 << 2)) msg.readShort();
    if (bits & (1 << 3)) msg.readBits(CLIENTNUM_BITS);
    if (protocol119) {
      if (bits & (1 << 4)) msg.readByte();
    } else {
      if (bits & (1 << 4)) msg.readShort();
      if (bits & (1 << 5)) msg.readByte();
    }
  }
  if (msg.overflowed) return null;
  if (msg.readBit() === 1) {
    for (let group = 0; group < 4; group++) {
      if (msg.readBit() === 1) {
        const mask = msg.readShort();
        for (let i = 0; i < 16; i++) if (mask & (1 << i)) msg.readShort();
      }
    }
  }
  for (let group = 0; group < 4; group++) {
    if (msg.readBit() === 1) {
      const mask = msg.readShort();
      for (let i = 0; i < 16; i++) if (mask & (1 << i)) msg.readShort();
    }
  }
  if (msg.overflowed) return null;
  if (msg.readBit() === 1) {
    const dummy = new Int32Array(OBJECTIVE_FIELDS.length);
    for (let i = 0; i < MAX_OBJECTIVES; i++) {
      msg.readBits(OBJECTIVE_STATE_BITS);
      if (msg.readBit() === 1) {
        for (let f = 0; f < OBJECTIVE_FIELDS.length; f++) {
          const field = OBJECTIVE_FIELDS[f];
          if (!field || !readDeltaField(msg, dummy, dummy, f, field))
            return null;
        }
      }
    }
  }
  if (msg.overflowed) return null;
  if (msg.readBit() === 1) {
    if (!readHudElems(msg) || !readHudElems(msg)) return null;
  }
  return msg.overflowed ? null : to;
}

function readHudElems(msg: BitMsg): boolean {
  const inuse = msg.readBits(HUDELEM_BITS);
  if (inuse > MAX_HUDELEMS || msg.overflowed) return false;
  const dummy = new Int32Array(HUD_FIELDS.length);
  for (let i = 0; i < inuse; i++) {
    const lc = msg.readBits(HUDELEM_BITS);
    if (lc >= HUD_FIELDS.length || msg.overflowed) return false;
    for (let j = 0; j <= lc; j++) {
      const field = HUD_FIELDS[j];
      if (!field || !readDeltaField(msg, dummy, dummy, j, field)) return false;
    }
  }
  return !msg.overflowed;
}

function readEntities(
  msg: BitMsg,
  deltaFromPrevious: boolean,
  baselines: Map<number, Int32Array>,
  previous: Map<number, Int32Array>,
): Map<number, Int32Array> | null {
  const oldNums = deltaFromPrevious
    ? [...previous.keys()].sort((a, b) => a - b)
    : [];
  let oldIndex = 0;
  const next = new Map<number, Int32Array>();
  const zero = new Int32Array(ENTITY_FIELDS.length);
  while (true) {
    const newNum = msg.readBits(GENTITYNUM_BITS);
    if (msg.overflowed || newNum > ENTITYNUM_NONE) return null;
    if (newNum === ENTITYNUM_NONE) break;
    while (oldIndex < oldNums.length && (oldNums[oldIndex] ?? 0) < newNum) {
      const num = oldNums[oldIndex] ?? 0;
      const prev = previous.get(num);
      if (prev) next.set(num, prev.slice());
      oldIndex++;
    }
    const matches = oldIndex < oldNums.length && oldNums[oldIndex] === newNum;
    const from = matches
      ? (previous.get(newNum) ?? zero)
      : (baselines.get(newNum) ?? zero);
    const parsed = readDeltaStruct(msg, from, ENTITY_FIELDS);
    if (parsed === null) return null;
    if (parsed !== 'removed') next.set(newNum, parsed);
    if (matches) oldIndex++;
  }
  while (oldIndex < oldNums.length) {
    const num = oldNums[oldIndex] ?? 0;
    const prev = previous.get(num);
    if (prev) next.set(num, prev.slice());
    oldIndex++;
  }
  return next;
}

function readClients(
  msg: BitMsg,
  deltaFromPrevious: boolean,
  previous: Map<number, Int32Array>,
): Map<number, Int32Array> | null {
  const oldNums = deltaFromPrevious
    ? [...previous.keys()].sort((a, b) => a - b)
    : [];
  let oldIndex = 0;
  const next = new Map<number, Int32Array>();
  const zero = new Int32Array(CLIENT_FIELDS.length);
  while (msg.readBit() === 1) {
    const newNum = msg.readBits(CLIENTNUM_BITS);
    if (msg.overflowed || newNum >= 64) return null;
    while (oldIndex < oldNums.length && (oldNums[oldIndex] ?? 0) < newNum) {
      const num = oldNums[oldIndex] ?? 0;
      const prev = previous.get(num);
      if (prev) next.set(num, prev.slice());
      oldIndex++;
    }
    const matches = oldIndex < oldNums.length && oldNums[oldIndex] === newNum;
    const from = matches ? (previous.get(newNum) ?? zero) : zero;
    const parsed = readDeltaStruct(msg, from, CLIENT_FIELDS);
    if (parsed === null) return null;
    if (parsed !== 'removed') next.set(newNum, parsed);
    if (matches) oldIndex++;
  }
  if (msg.overflowed) return null;
  while (oldIndex < oldNums.length) {
    const num = oldNums[oldIndex] ?? 0;
    const prev = previous.get(num);
    if (prev) next.set(num, prev.slice());
    oldIndex++;
  }
  return next;
}

const ORIGIN_X = fieldIndex(ENTITY_FIELDS, 'pos.trBase[0]');
const ORIGIN_Y = fieldIndex(ENTITY_FIELDS, 'pos.trBase[1]');
const ORIGIN_Z = fieldIndex(ENTITY_FIELDS, 'pos.trBase[2]');
const DELTA_X = fieldIndex(ENTITY_FIELDS, 'pos.trDelta[0]');
const DELTA_Y = fieldIndex(ENTITY_FIELDS, 'pos.trDelta[1]');
const DELTA_Z = fieldIndex(ENTITY_FIELDS, 'pos.trDelta[2]');
const ANGLE_PITCH = fieldIndex(ENTITY_FIELDS, 'apos.trBase[0]');
const ANGLE_YAW = fieldIndex(ENTITY_FIELDS, 'apos.trBase[1]');
const ANGLE_ROLL = fieldIndex(ENTITY_FIELDS, 'apos.trBase[2]');
const ETYPE = fieldIndex(ENTITY_FIELDS, 'eType');
const CLIENT_NUM = fieldIndex(ENTITY_FIELDS, 'clientNum');
const WEAPON = fieldIndex(ENTITY_FIELDS, 'weapon');
const TEAM = fieldIndex(CLIENT_FIELDS, 'team');

function observe(
  serverTimeMs: number,
  entities: Map<number, Int32Array>,
): EntityObservation[] {
  const players: EntityObservation[] = [];
  for (const [entityNum, state] of entities) {
    if ((state[ETYPE] ?? 0) !== ET_PLAYER) continue;
    players.push({
      serverTimeMs,
      entityNum,
      eType: ET_PLAYER,
      clientNum: state[CLIENT_NUM] ?? 0,
      origin: [
        bitsToFloat(state[ORIGIN_X] ?? 0),
        bitsToFloat(state[ORIGIN_Y] ?? 0),
        bitsToFloat(state[ORIGIN_Z] ?? 0),
      ],
      velocity: [
        bitsToFloat(state[DELTA_X] ?? 0),
        bitsToFloat(state[DELTA_Y] ?? 0),
        bitsToFloat(state[DELTA_Z] ?? 0),
      ],
      viewangles: [
        bitsToFloat(state[ANGLE_PITCH] ?? 0),
        bitsToFloat(state[ANGLE_YAW] ?? 0),
        bitsToFloat(state[ANGLE_ROLL] ?? 0),
      ],
      weapon: state[WEAPON] ?? 0,
    });
  }
  return players;
}

function parseGamestate(msg: BitMsg, state: ParseState): boolean {
  state.checksumFeed = null;
  const reliable = msg.readLong();
  if (msg.overflowed) return false;
  void reliable;
  while (true) {
    const op = msg.readByte();
    if (op < 0) return false;
    if (op === SVC_EOF) break;
    if (op === SVC_CONFIGSTRING) {
      const index = msg.readShort();
      const text = readCString(msg, BIG_INFO_STRING);
      if (text === null || index >= MAX_CONFIGSTRINGS) return false;
      state.configstrings.set(index, text);
      continue;
    }
    if (op === SVC_BASELINE) {
      const num = msg.readBits(GENTITYNUM_BITS);
      if (msg.overflowed || num >= ENTITYNUM_NONE) return false;
      const parsed = readDeltaStruct(
        msg,
        new Int32Array(ENTITY_FIELDS.length),
        ENTITY_FIELDS,
      );
      if (parsed === null || parsed === 'removed') return false;
      state.baselines.set(num, parsed);
      continue;
    }
    return false;
  }
  state.clientNum = msg.readLong();
  state.checksumFeed = msg.readLong();
  const end = msg.readByte();
  return !msg.overflowed && end === SVC_EOF;
}

function parseSnapshot(
  msg: BitMsg,
  state: ParseState,
  protocol: number,
): ParsedSnapshot | null {
  const serverTimeMs = msg.readLong();
  const lastframe = msg.readByte();
  const snapFlags = msg.readByte();
  if (msg.overflowed || lastframe < 0) return null;
  const delta = lastframe !== 0;
  const player = readPlayerstate(
    msg,
    delta ? state.playerState : new Int32Array(PLAYER_FIELDS.length),
    protocol,
  );
  if (!player) return null;
  const entities = readEntities(msg, delta, state.baselines, state.entities);
  if (!entities) return null;
  const clients = readClients(msg, delta, state.clients);
  if (!clients) return null;
  state.playerState = player;
  state.entities = entities;
  state.clients = clients;
  return {
    serverTimeMs,
    lastframe,
    snapFlags,
    players: observe(serverTimeMs, entities),
    clients: [...clients.entries()].map(([clientIndex, fields]) => ({
      clientIndex,
      team: fields[TEAM] ?? 0,
    })),
  };
}

const SAFE_MAP_NAME = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Map name and team scores carried in a gamestate. `mapname` lives in
 * serverinfo. CS_SCORES1 is Axis and CS_SCORES2 is Allies; a deathmatch
 * leaves both at 0. A missing string stays null so a later `d` command can
 * fill it without pretending the score was zero.
 */
export function readScoreGamestate(
  configstrings: ReadonlyMap<number, string>,
): {
  mapName: string | null;
  axis: number | null;
  allies: number | null;
} {
  const info = configstrings.get(CS_SERVERINFO);
  const mapname = info ? parseCvarBlock(info)['mapname']?.trim() : undefined;
  return {
    mapName: mapname && SAFE_MAP_NAME.test(mapname) ? mapname : null,
    axis: configstringScore(configstrings.get(CS_SCORES1)),
    allies: configstringScore(configstrings.get(CS_SCORES2)),
  };
}

function configstringScore(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  if (Math.abs(value) > 1_000_000) return null;
  return value;
}

function serverIdFrom(configstrings: Map<number, string>): number | null {
  for (const index of [CS_SYSTEMINFO, CS_SERVERINFO]) {
    const text = configstrings.get(index);
    if (!text) continue;
    const keys = parseCvarBlock(text);
    const raw = keys['sv_serverid'] ?? keys['sv_serverId'];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (Number.isInteger(value)) return value & 0xff;
  }
  return null;
}

/** Parse one decompressed server message. Truncation fails the parse and does not throw. */
export function parseServerMessage(
  bytes: Uint8Array,
  protocol: number,
  previous: ParseState = emptyParseState(),
): ParseResult {
  const msg = new BitMsg(bytes);
  const state: ParseState = {
    baselines: new Map(previous.baselines),
    entities: previous.entities,
    clients: previous.clients,
    playerState: previous.playerState,
    configstrings: new Map(previous.configstrings),
    clientNum: previous.clientNum,
    checksumFeed: previous.checksumFeed,
  };
  const message: ParsedMessage = {
    lastClientCommand: msg.readLong(),
    serverCommands: [],
    configstrings: state.configstrings,
    clientNum: state.clientNum,
    checksumFeed: state.checksumFeed,
    gamestate: false,
    serverId: null,
    snapshots: [],
  };
  if (msg.overflowed)
    return { ok: false, reason: 'truncated', serverCommands: [] };
  while (msg.readcount < msg.cursize) {
    const op = msg.readByte();
    if (op < 0) break;
    if (op === SVC_NOP) continue;
    if (op === SVC_EOF) break;
    if (op === SVC_SERVER_COMMAND) {
      const seq = msg.readLong();
      const text = readCString(msg, MAX_STRING_CHARS);
      if (text === null || msg.overflowed)
        return {
          ok: false,
          reason: 'truncated',
          serverCommands: message.serverCommands,
        };
      message.serverCommands.push({ seq, text });
      continue;
    }
    if (op === SVC_GAMESTATE) {
      if (!parseGamestate(msg, state))
        return {
          ok: false,
          reason: 'truncated',
          serverCommands: message.serverCommands,
        };
      message.clientNum = state.clientNum;
      message.checksumFeed = state.checksumFeed;
      message.gamestate = true;
      message.serverId = serverIdFrom(state.configstrings);
      continue;
    }
    if (op === SVC_SNAPSHOT) {
      const snapshot = parseSnapshot(msg, state, protocol);
      if (!snapshot)
        return {
          ok: false,
          reason: 'truncated',
          serverCommands: message.serverCommands,
        };
      message.snapshots.push(snapshot);
      continue;
    }
    if (op === SVC_DOWNLOAD || op === SVC_CONFIGSTRING || op === SVC_BASELINE) {
      return {
        ok: false,
        reason: 'framing',
        serverCommands: message.serverCommands,
      };
    }
    return {
      ok: false,
      reason: 'framing',
      serverCommands: message.serverCommands,
    };
  }
  message.serverId = message.serverId ?? serverIdFrom(state.configstrings);
  return { ok: true, message, state };
}
