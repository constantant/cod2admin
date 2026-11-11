import {
  buildOobPacket,
  encodeText,
  parseCvarBlock,
} from '@cod2admin/rcon-client';
import { BitMsg } from './bit-msg.js';
import {
  CLC_CLIENT_COMMAND,
  CLC_EOF,
  CLC_MOVE,
  CLC_MOVE_NO_DELTA,
  CLIENT_CLEAR_HEADER,
  FRAGMENT_BIT,
  FRAGMENT_SIZE,
  MAX_DATAGRAM,
  SV_ENCODE_START,
  fragmentStartBytes,
  maxMessageLength,
} from './constants.js';
import {
  huffmanCompress,
  huffmanDecompress,
  type HuffResult,
} from './huffman.js';

export const SPECTATOR_NAME = 'AdminWatch';
export const SPECTATOR_RATE = 25000;
export const SPECTATOR_SNAPS = 20;

export interface StatusInfo {
  protocol: number | null;
  sv_pure: string | null;
  sv_punkbuster: string | null;
  sv_fps: string | null;
  keys: Record<string, string>;
}

/** `body` is the text after `statusResponse\\n`. Missing keys stay null. */
export function parseStatusBody(body: string): StatusInfo {
  const line = body.split('\n', 1)[0] ?? '';
  const keys = parseCvarBlock(line);
  const protocol =
    keys['protocol'] !== undefined && /^-?\d+$/.test(keys['protocol'])
      ? Number(keys['protocol'])
      : null;
  return {
    protocol,
    sv_pure: keys['sv_pure'] ?? null,
    sv_punkbuster: keys['sv_punkbuster'] ?? null,
    sv_fps: keys['sv_fps'] ?? null,
    keys,
  };
}

export type ConnectGate =
  { ok: true; protocol: number } | { ok: false; reason: string };

/**
 * Production connect. A missing PunkBuster key is not off. `sv_pure` is not a
 * gate: the peer answers it with {@link pureClientCommand}. The protocol is
 * the `getstatus` value, not a hardcoded 115 or 118.
 */
export function connectAllowed(info: StatusInfo): ConnectGate {
  if (info.protocol === null)
    return { ok: false, reason: 'protocol missing from getstatus' };
  if (info.sv_punkbuster === null)
    return { ok: false, reason: 'sv_punkbuster missing from getstatus' };
  if (info.sv_punkbuster !== '0')
    return {
      ok: false,
      reason: `sv_punkbuster is ${JSON.stringify(info.sv_punkbuster)}`,
    };
  return { ok: true, protocol: info.protocol };
}

/**
 * CoD2 `cp` for a client that referenced no iwds.
 *
 * `SV_VerifyIwds_f` rejects a checksum the server did not load, then checks
 * `checksumFeed ^ each checksum ^ count`. An empty list leaves the trailer
 * equal to `checksumFeed`. It does not echo `sv_iwds`.
 */
export function pureClientCommand(checksumFeed: number): string {
  return `cp @ ${checksumFeed | 0}`;
}

/**
 * Reliable client commands. CoD2 drops the client with
 * `EXE_LOSTRELIABLECOMMANDS` when a sequence skips even one number, and it
 * ignores the whole packet across a map change. Unacked commands are resent
 * with the same sequence. A new gamestate rewrites an unacked `cp` in place
 * so the old feed is never executed.
 */
export interface ReliableCommandState {
  commandSeq: number;
  /** Highest client-command sequence the server has executed. */
  ack: number;
  sent: Map<number, string>;
  needPure: boolean;
  checksumFeed: number;
  /** `team spectator` has been queued. */
  sentTeam: boolean;
}

export function acknowledgeReliableCommands(
  state: ReliableCommandState,
  ack: number,
): void {
  if (ack > state.ack) state.ack = ack;
  // Keep the acked text. The next server packet XORs with it.
  for (const seq of state.sent.keys()) {
    if (seq < state.ack) state.sent.delete(seq);
  }
}

export function unackedReliableCommands(
  state: ReliableCommandState,
): { seq: number; text: string }[] {
  return [...state.sent.entries()]
    .filter(([seq]) => seq > state.ack)
    .sort((left, right) => left[0] - right[0])
    .map(([seq, text]) => ({ seq, text }));
}

/** Queue `cp` and `team spectator` once, then return every command still unacked. */
export function collectReliableCommands(
  state: ReliableCommandState,
): { seq: number; text: string }[] {
  if (state.needPure) {
    const text = pureClientCommand(state.checksumFeed);
    const pending = unackedReliableCommands(state).find((command) =>
      command.text.startsWith('cp '),
    );
    if (pending) {
      pending.text = text;
      state.sent.set(pending.seq, text);
    } else {
      state.sent.set(state.commandSeq, text);
      state.commandSeq += 1;
    }
    state.needPure = false;
  }
  if (!state.sentTeam) {
    state.sent.set(state.commandSeq, 'team spectator');
    state.commandSeq += 1;
    state.sentTeam = true;
  }
  return unackedReliableCommands(state);
}

export function buildGetstatusPacket(): Buffer {
  return buildOobPacket('getstatus');
}

export function buildGetchallengePacket(): Buffer {
  return buildOobPacket('getchallenge');
}

/** `\\`, `"`, and `;` would add userinfo keys or end the connect quotes. */
export function sanitizeSpectatorName(name: string): string {
  const cleaned = name.replace(/[\\";]/g, '');
  return cleaned.length > 0 ? cleaned : SPECTATOR_NAME;
}

export function buildSpectatorUserinfo(options: {
  protocol: number;
  challenge: number;
  qport: number;
  /** Omitted: the disclosed `AdminWatch` name. Not a private-slot password. */
  name?: string;
}): string {
  const name = sanitizeSpectatorName(options.name ?? SPECTATOR_NAME);
  // No checksum, password, cl_hwid, or private-slot key. Snaps is a request only.
  return [
    `\\protocol\\${options.protocol}`,
    `\\qport\\${options.qport}`,
    `\\challenge\\${options.challenge}`,
    `\\name\\${name}`,
    `\\rate\\${SPECTATOR_RATE}`,
    `\\snaps\\${SPECTATOR_SNAPS}`,
    '\\cl_punkbuster\\0',
  ].join('');
}

export function buildConnectPacket(userinfo: string): Buffer {
  // Name bytes are CP1251. The rest of userinfo is ASCII, which matches.
  return buildOobPacket(`connect "${userinfo}"`, 'cp1251');
}

/** XOR is its own inverse. Empty command leaves the key unchanged. */
export function xorNetchan(
  data: Uint8Array,
  key0: number,
  command: string,
): void {
  const bytes =
    command.length === 0 ? new Uint8Array() : encodeText(command, 'cp1251');
  let key = key0 & 0xff;
  let index = 0;
  for (let i = 0; i < data.length; i++) {
    if (bytes.length === 0 || index >= bytes.length || bytes[index] === 0)
      index = 0;
    const symbol = bytes.length === 0 ? 0 : (bytes[index] ?? 0);
    key = (key ^ (symbol << (i & 1))) & 0xff;
    data[i] = (data[i] ?? 0) ^ key;
    index++;
  }
}

export function comHashKey(text: string, maxlen = 32): number {
  const bytes = encodeText(text, 'cp1251');
  let hash = 0;
  const n = Math.min(bytes.length, maxlen);
  for (let i = 0; i < n; i++) {
    const symbol = bytes[i] ?? 0;
    if (symbol === 0) break;
    hash = (hash + symbol * (119 + i)) | 0;
  }
  return (hash ^ (hash >> 10) ^ (hash >> 20)) | 0;
}

export interface ClientDatagram {
  sequence: number;
  qport: number;
  challenge: number;
  serverId: number;
  messageAcknowledge: number;
  reliableAcknowledge: number;
  /** Server command text in the slot we are acknowledging. XOR and the usercmd key both use it. */
  ackedServerCommand: string;
  checksumFeed: number;
  serverTime: number;
  commands: readonly { seq: number; text: string }[];
  /**
   * Keepalive. Omitted for a bare reliable command. A move holds jump and
   * nothing else: CoD2 counts jump as activity, and it does not walk or fire.
   */
  move: boolean;
  /**
   * Ask for a snapshot compressed against the one this packet acknowledges.
   * A full snapshot of a busy server is larger than one datagram. The server
   * drips the fragments at `rate`, and `SV_CalcPings` counts that wait as the
   * client's ping because the ack is sent only when the last fragment arrives.
   */
  delta?: boolean;
}

/** `MSG_WriteKey`: the wire bit is `value ^ (key & 1)`. */
function writeKeyedBit(msg: BitMsg, key: number, value: number): void {
  msg.writeBit((value ^ key) & 1);
}

/**
 * `buttons >> 1` after `key ^= serverTime`. 512 is `BUTTON_JUMP >> 1`.
 * Weapon, off-hand, and roll stay equal to the zero cmd.
 */
function writeJumpButton(msg: BitMsg, key: number): void {
  msg.writeBit(0);
  msg.writeBit(1);
  msg.writeBits((512 ^ key) | 0, 18);
  msg.writeBit(0);
  msg.writeBit(0);
}

function writeClientBody(packet: ClientDatagram): BitMsg {
  const msg = BitMsg.alloc(1024);
  for (const command of packet.commands) {
    msg.writeBits(CLC_CLIENT_COMMAND, 3);
    msg.writeLong(command.seq);
    const bytes = encodeText(command.text, 'cp1251');
    const n = Math.min(bytes.length, 1023);
    for (let i = 0; i < n; i++) msg.writeByte(bytes[i] ?? 0);
    msg.writeByte(0);
  }
  if (packet.move) {
    msg.writeBits(packet.delta ? CLC_MOVE : CLC_MOVE_NO_DELTA, 3);
    msg.writeByte(1);
    const key =
      (packet.checksumFeed ^
        packet.messageAcknowledge ^
        comHashKey(packet.ackedServerCommand, 32)) |
      0;
    // serverTime from a zero cmd. Under 256 takes the delta path; otherwise a full time.
    if (packet.serverTime >= 0 && packet.serverTime < 256) {
      msg.writeBit(1);
      msg.writeByte(packet.serverTime);
    } else {
      msg.writeBit(0);
      msg.writeLong(packet.serverTime);
    }
    // Long form against a zero cmd: jump only. A no-change cmd leaves forward,
    // right, attack, and jump at 0, and ClientInactivityTimer then drops the
    // spectator. Jump is BUTTON_JUMP (1024), not attack, and the move mask and
    // angles stay 0, so the body does not walk or aim.
    writeKeyedBit(msg, key, 1);
    writeKeyedBit(msg, key, 1);
    writeKeyedBit(msg, key, 0);
    msg.writeBit(0);
    msg.writeBit(0);
    msg.writeBit(0);
    writeJumpButton(msg, (key ^ packet.serverTime) | 0);
  } else {
    msg.writeBits(CLC_EOF, 3);
  }
  return msg;
}

/** Sequenced client packet. Not an OOB `disconnect` — the server ignores that. */
export function buildClientDatagram(packet: ClientDatagram): Buffer {
  const body = writeClientBody(packet);
  const plain = body.bytes();
  const compressed = huffmanCompress(plain, 2048);
  if (!compressed.ok) throw new Error('client command exceeded Huffman cap');
  const payload = new Uint8Array(CLIENT_CLEAR_HEADER + compressed.data.length);
  payload[0] = packet.serverId & 0xff;
  payload[1] = packet.messageAcknowledge & 0xff;
  payload[2] = (packet.messageAcknowledge >> 8) & 0xff;
  payload[3] = (packet.messageAcknowledge >> 16) & 0xff;
  payload[4] = (packet.messageAcknowledge >> 24) & 0xff;
  payload[5] = packet.reliableAcknowledge & 0xff;
  payload[6] = (packet.reliableAcknowledge >> 8) & 0xff;
  payload[7] = (packet.reliableAcknowledge >> 16) & 0xff;
  payload[8] = (packet.reliableAcknowledge >> 24) & 0xff;
  payload.set(compressed.data, CLIENT_CLEAR_HEADER);
  const key =
    (packet.challenge ^ (packet.serverId & 0xff) ^ packet.messageAcknowledge) &
    0xff;
  xorNetchan(
    payload.subarray(CLIENT_CLEAR_HEADER),
    key,
    packet.ackedServerCommand,
  );
  const out = Buffer.alloc(6 + payload.length);
  out.writeInt32LE(packet.sequence | 0, 0);
  out.writeUInt16LE(packet.qport & 0xffff, 4);
  Buffer.from(payload).copy(out, 6);
  return out;
}

export function buildDisconnectDatagram(
  packet: Omit<ClientDatagram, 'commands' | 'move'> & { commandSeq: number },
): Buffer {
  return buildClientDatagram({
    ...packet,
    commands: [{ seq: packet.commandSeq, text: 'disconnect' }],
    move: false,
  });
}

export interface DecodedClientDatagram {
  sequence: number;
  qport: number;
  serverId: number;
  messageAcknowledge: number;
  reliableAcknowledge: number;
  commands: string[];
  move: boolean;
}

/** Inverse of `buildClientDatagram` for tests. Uses the same challenge and ack string the builder used. */
export function decodeClientDatagram(
  datagram: Buffer,
  challenge: number,
  ackedServerCommand: string,
): DecodedClientDatagram | null {
  if (datagram.length < 6 + CLIENT_CLEAR_HEADER) return null;
  const sequence = datagram.readInt32LE(0);
  const qport = datagram.readUInt16LE(4);
  const payload = Uint8Array.from(datagram.subarray(6));
  const serverId = payload[0] ?? 0;
  const messageAcknowledge = datagram.readInt32LE(7);
  const reliableAcknowledge = datagram.readInt32LE(11);
  const key = (challenge ^ serverId ^ messageAcknowledge) & 0xff;
  const compressed = payload.subarray(CLIENT_CLEAR_HEADER);
  xorNetchan(compressed, key, ackedServerCommand);
  const plain = huffmanDecompress(compressed, 2048);
  if (!plain.ok) return null;
  const msg = new BitMsg(plain.data);
  const commands: string[] = [];
  let move = false;
  while (!msg.overflowed) {
    const op = msg.readBits(3);
    if (msg.overflowed) break;
    if (op === CLC_EOF) break;
    if (op === CLC_CLIENT_COMMAND) {
      msg.readLong();
      const bytes: number[] = [];
      for (;;) {
        const c = msg.readByte();
        if (c <= 0) break;
        bytes.push(c);
      }
      commands.push(Buffer.from(bytes).toString('latin1'));
      continue;
    }
    if (op === CLC_MOVE || op === CLC_MOVE_NO_DELTA) {
      move = true;
      break;
    }
    return null;
  }
  return {
    sequence,
    qport,
    serverId,
    messageAcknowledge,
    reliableAcknowledge,
    commands,
    move,
  };
}

export class FragmentAssembler {
  private sequence = -1;
  private length = 0;
  private readonly buffer: Uint8Array;

  constructor(private readonly protocol: number) {
    this.buffer = new Uint8Array(maxMessageLength(protocol));
  }

  /** `pending` means more fragments follow. Failure does not throw. */
  push(
    datagram: Uint8Array,
  ):
    | { ok: true; pending: boolean; sequence: number; message: Uint8Array }
    | { ok: false; reason: 'cap' | 'truncated' } {
    if (datagram.length > MAX_DATAGRAM) return { ok: false, reason: 'cap' };
    if (datagram.length < 4) return { ok: false, reason: 'truncated' };
    const sequenceWord =
      (datagram[0] ?? 0) |
      ((datagram[1] ?? 0) << 8) |
      ((datagram[2] ?? 0) << 16) |
      ((datagram[3] ?? 0) << 24);
    const fragmented = (sequenceWord & FRAGMENT_BIT) !== 0;
    const sequence = (sequenceWord >>> 0) & ~FRAGMENT_BIT;
    if (!fragmented) {
      this.length = 0;
      this.sequence = sequence;
      return {
        ok: true,
        pending: false,
        sequence,
        message: datagram.subarray(4),
      };
    }
    const startBytes = fragmentStartBytes(this.protocol);
    const header = 4 + startBytes + 2;
    if (datagram.length < header) return { ok: false, reason: 'truncated' };
    let fragmentStart = 0;
    if (startBytes === 4) {
      fragmentStart =
        (datagram[4] ?? 0) |
        ((datagram[5] ?? 0) << 8) |
        ((datagram[6] ?? 0) << 16) |
        ((datagram[7] ?? 0) << 24);
    } else {
      fragmentStart = (datagram[4] ?? 0) | ((datagram[5] ?? 0) << 8);
    }
    const lengthOffset = 4 + startBytes;
    const fragmentLength =
      (datagram[lengthOffset] ?? 0) | ((datagram[lengthOffset + 1] ?? 0) << 8);
    const payload = datagram.subarray(header);
    if (fragmentLength > payload.length || fragmentLength > FRAGMENT_SIZE)
      return { ok: false, reason: 'cap' };
    if (sequence !== this.sequence) {
      this.sequence = sequence;
      this.length = 0;
    }
    if (fragmentStart !== this.length)
      return { ok: false, reason: 'truncated' };
    if (this.length + fragmentLength > this.buffer.length)
      return { ok: false, reason: 'cap' };
    this.buffer.set(payload.subarray(0, fragmentLength), this.length);
    this.length += fragmentLength;
    if (fragmentLength === FRAGMENT_SIZE)
      return { ok: true, pending: true, sequence, message: new Uint8Array() };
    const message = this.buffer.slice(0, this.length);
    this.length = 0;
    return { ok: true, pending: false, sequence, message };
  }
}

export function decodeServerPayload(
  message: Uint8Array,
  challenge: number,
  sequence: number,
  clientCommand: string,
  protocol: number,
): HuffResult {
  if (message.length < SV_ENCODE_START)
    return { ok: false, reason: 'truncated' };
  const compressed = message.slice(SV_ENCODE_START);
  const key = (challenge ^ sequence) & 0xff;
  xorNetchan(compressed, key, clientCommand);
  const plain = huffmanDecompress(
    compressed,
    maxMessageLength(protocol) - SV_ENCODE_START,
  );
  if (!plain.ok) return plain;
  const out = new Uint8Array(SV_ENCODE_START + plain.data.length);
  out.set(message.subarray(0, SV_ENCODE_START), 0);
  out.set(plain.data, SV_ENCODE_START);
  return { ok: true, data: out };
}
