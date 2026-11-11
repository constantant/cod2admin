import { lookup } from 'node:dns/promises';
import dgram from 'node:dgram';
import type { Sample } from '@cod2admin/player-watch';
import { parseOobPacket } from '@cod2admin/rcon-client';
import { CS_SERVERINFO, CS_SYSTEMINFO, MAX_DATAGRAM } from './constants.js';
import type { EntityObservation } from './snapshot.js';
import {
  emptyParseState,
  parseServerMessage,
  type ParseState,
} from './snapshot.js';
import {
  buildClientDatagram,
  buildConnectPacket,
  buildDisconnectDatagram,
  buildGetchallengePacket,
  buildGetstatusPacket,
  buildSpectatorUserinfo,
  connectAllowed,
  decodeServerPayload,
  pureClientCommand,
  FragmentAssembler,
  parseStatusBody,
  type StatusInfo,
} from './wire.js';

export class ConnectRefusedError extends Error {
  readonly status: StatusInfo;

  constructor(reason: string, status: StatusInfo) {
    super(reason);
    this.name = 'ConnectRefusedError';
    this.status = status;
  }
}

export interface GamePeerOptions {
  host: string;
  port: number;
  /** Stamped on each `Sample`. Defaults to `host:port`. */
  serverAlias?: string;
  /** Spectator userinfo name. Omitted: `AdminWatch`. Never a password. */
  name?: string;
  timeoutMs?: number;
  onDatagram?: (direction: 'in' | 'out', bytes: Buffer) => void;
  /** Called as snapshots parse. The spike's `watch()` still collects them too. */
  onSample?: (sample: Sample) => void;
  /**
   * One call per snapshot, after `onSample`. Samples are already filed per
   * subject slot, including the other visible players.
   */
  onSnapshot?: (samples: Sample[]) => void;
  /**
   * The server stopped answering after connect. The socket is already closed.
   * The caller reconnects; this peer does not.
   */
  onDropped?: () => void;
}

export interface WatchResult {
  serverCommands: string[];
  oobMessages: string[];
  snapshotCount: number;
  /** Server time of each parsed snapshot, in order. */
  serverTimes: number[];
  /** Local receive time of each parsed snapshot. */
  receivedAt: number[];
  samples: Sample[];
  spectatorTeam: number | null;
  clientNum: number | null;
  parseFailures: number;
  systemInfo: string | null;
  serverInfo: string | null;
  serverId: number | null;
}

interface Pending {
  resolve: (header: string, body: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  match: (header: string, body: string) => boolean;
}

/**
 * Spectator-only peer. The keepalive holds jump so the server does not drop an
 * idle client. It does not walk, aim, or fire, and it sends no private password.
 * `connect` refuses unless getstatus has `sv_punkbuster` equal to `0`.
 * `sv_pure` is answered with an empty `cp`, not by turning the cvar off.
 */
// Assigned from the class static block. `open` stays private, so the pure probe is not a GamePeer method.
let openPeer!: (
  options: GamePeerOptions,
  enforceGate: boolean,
) => Promise<GamePeer>;

export class GamePeer {
  static {
    openPeer = (options, enforceGate) => GamePeer.open(options, enforceGate);
  }

  readonly status: StatusInfo;
  protocol: number;
  private readonly socket: dgram.Socket;
  private readonly host: string;
  private readonly port: number;
  private readonly serverAlias: string;
  private readonly onDatagram?: GamePeerOptions['onDatagram'];
  private readonly onSample?: GamePeerOptions['onSample'];
  private readonly onSnapshot?: GamePeerOptions['onSnapshot'];
  private readonly onDropped?: GamePeerOptions['onDropped'];
  private challenge: number;
  private readonly qport: number;
  private fragments: FragmentAssembler;
  private parseState: ParseState = emptyParseState();
  private outgoing = 1;
  private commandSeq = 1;
  private serverId = 0;
  private learnedServerId = false;
  private messageAcknowledge = 0;
  private reliableAcknowledge = 0;
  private checksumFeed = 0;
  private haveGamestate = false;
  /** A new gamestate resets the server's pure flag, so `cp` has to be sent again. */
  private needPure = false;
  private sentTeam = false;
  private keepalive: ReturnType<typeof setInterval> | undefined;
  /** Last datagram from the server. `run` starts the silence clock. */
  private lastPacketAt = 0;
  private cmdTime = 50;
  private closed = false;
  /** Set before the leave packet is built, so a keepalive cannot sneak out after it. */
  private suppressSend = false;
  private leaving: Promise<void> | null = null;
  private readonly sentCommands = new Map<number, string>();
  private readonly serverCommandText = new Map<number, string>();
  private readonly pending: Pending[] = [];
  private readonly watchState: WatchResult = {
    serverCommands: [],
    oobMessages: [],
    snapshotCount: 0,
    serverTimes: [],
    receivedAt: [],
    samples: [],
    spectatorTeam: null,
    clientNum: null,
    parseFailures: 0,
    systemInfo: null,
    serverInfo: null,
    serverId: null,
  };

  private constructor(
    options: GamePeerOptions,
    status: StatusInfo,
    protocol: number,
    socket: dgram.Socket,
    challenge: number,
  ) {
    this.status = status;
    this.protocol = protocol;
    this.socket = socket;
    this.host = options.host;
    this.port = options.port;
    this.serverAlias = options.serverAlias ?? `${options.host}:${options.port}`;
    this.onDatagram = options.onDatagram;
    this.onSample = options.onSample;
    this.onSnapshot = options.onSnapshot;
    this.onDropped = options.onDropped;
    this.challenge = challenge;
    this.qport = 1 + Math.floor(Math.random() * 65534);
    this.fragments = new FragmentAssembler(protocol);
    socket.on('error', () => undefined);
    socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
  }

  static connect(options: GamePeerOptions): Promise<GamePeer> {
    return GamePeer.open(options, true);
  }

  private static async open(
    options: GamePeerOptions,
    enforceGate: boolean,
  ): Promise<GamePeer> {
    const timeoutMs = options.timeoutMs ?? 3000;
    const host = (await lookup(options.host, { family: 4 })).address;
    const resolved: GamePeerOptions = {
      ...options,
      host,
      serverAlias: options.serverAlias ?? `${options.host}:${options.port}`,
    };
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
    const peer = new GamePeer(resolved, emptyStatus(), 0, socket, 0);
    try {
      const statusBody = await peer.roundTrip(
        buildGetstatusPacket(),
        timeoutMs,
        (header) => header === 'statusResponse',
      );
      const status = parseStatusBody(statusBody);
      Object.assign(peer.status, status);
      const gate = connectAllowed(status);
      if (enforceGate && !gate.ok) {
        peer.close();
        throw new ConnectRefusedError(gate.reason, status);
      }
      if (status.protocol === null) {
        peer.close();
        throw new ConnectRefusedError(
          'protocol missing from getstatus',
          status,
        );
      }
      const challengeLine = await peer.roundTrip(
        buildGetchallengePacket(),
        timeoutMs,
        (header) => header.startsWith('challengeResponse'),
      );
      const challenge = Number(
        /^challengeResponse\s+(-?\d+)/.exec(challengeLine)?.[1] ?? Number.NaN,
      );
      if (!Number.isInteger(challenge)) {
        peer.close();
        throw new Error(`bad challenge response: ${challengeLine}`);
      }
      peer.adopt(status.protocol, challenge);
      const userinfo = buildSpectatorUserinfo({
        protocol: status.protocol,
        challenge,
        qport: peer.qport,
        name: resolved.name,
      });
      const connectBody = await peer.roundTrip(
        buildConnectPacket(userinfo),
        timeoutMs,
        (header) => {
          return header === 'connectResponse' || header === 'error';
        },
      );
      if (connectBody.startsWith('error')) {
        peer.close();
        throw new Error(connectBody.replace(/\0/g, ''));
      }
      return peer;
    } catch (error) {
      peer.close();
      throw error;
    }
  }

  async watch(durationMs: number): Promise<WatchResult> {
    this.sendTrigger();
    const timer = setInterval(() => this.sendKeepalive(), 50);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    clearInterval(timer);
    return this.watchState;
  }

  /** Keepalive until `disconnect`. The supervisor child uses this, not a timed `watch`. */
  run(): void {
    if (this.closed || this.keepalive) return;
    this.lastPacketAt = Date.now();
    this.sendTrigger();
    this.keepalive = setInterval(() => this.sendKeepalive(), 50);
    this.keepalive.unref?.();
  }

  /**
   * Reliable `disconnect`, then close. The promise settles after the datagram
   * has been handed to the kernel. Closing or exiting first drops it, and the
   * server keeps the spectator until it times out.
   */
  disconnect(): Promise<void> {
    if (this.leaving) return this.leaving;
    this.suppressSend = true;
    this.leaving = this.leave();
    return this.leaving;
  }

  private adopt(protocol: number, challenge: number): void {
    this.protocol = protocol;
    this.challenge = challenge;
    this.fragments = new FragmentAssembler(protocol);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new Error('socket closed'));
    }
    this.socket.close();
  }

  private async leave(): Promise<void> {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = undefined;
    }
    let packet: Buffer | null = null;
    if (!this.closed) {
      try {
        packet = buildDisconnectDatagram({
          sequence: this.outgoing,
          qport: this.qport,
          challenge: this.challenge,
          serverId: this.serverId,
          messageAcknowledge: this.messageAcknowledge,
          reliableAcknowledge: this.reliableAcknowledge,
          ackedServerCommand:
            this.serverCommandText.get(this.reliableAcknowledge) ?? '',
          checksumFeed: this.checksumFeed,
          serverTime: this.cmdTime,
          commandSeq: this.commandSeq,
        });
        this.outgoing++;
        this.commandSeq++;
      } catch {
        packet = null;
      }
    }
    // One UDP loss must not leave the spectator in the game. Same bytes each time.
    if (packet) {
      for (
        let attempt = 0;
        attempt < DISCONNECT_SENDS && !this.closed;
        attempt++
      ) {
        await this.flush(packet);
        if (attempt + 1 < DISCONNECT_SENDS && !this.closed) {
          await new Promise((resolve) =>
            setTimeout(resolve, DISCONNECT_GAP_MS),
          );
        }
      }
    }
    this.close();
  }

  /** Resolves when `socket.send` accepts the datagram, or after a short wait. */
  private flush(packet: Buffer): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.onDatagram?.('out', packet);
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => finish(), 250);
      try {
        this.socket.send(packet, this.port, this.host, () => finish());
      } catch {
        finish();
      }
    });
  }

  private send(packet: Buffer): void {
    if (this.closed || this.suppressSend) return;
    this.onDatagram?.('out', packet);
    this.socket.send(packet, this.port, this.host);
  }

  private roundTrip(
    packet: Buffer,
    timeoutMs: number,
    matchHeader: (header: string) => boolean,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((item) => item.timer === timer);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error('timed out waiting for server'));
      }, timeoutMs);
      this.pending.push({
        resolve: (header, body) =>
          resolve(
            header === 'statusResponse'
              ? body
              : body.length === 0
                ? header
                : `${header}\n${body}`,
          ),
        reject,
        timer,
        match: (header) => matchHeader(header),
      });
      this.send(packet);
    });
  }

  /** The server stopped sending. Close without a leave packet and tell the child. */
  private droppedByServer(): void {
    if (this.closed || this.leaving) return;
    this.close();
    this.onDropped?.();
  }

  private onMessage(message: Buffer, rinfo: dgram.RemoteInfo): void {
    this.lastPacketAt = Date.now();
    if (rinfo.address !== this.host || rinfo.port !== this.port) return;
    if (message.length > MAX_DATAGRAM) {
      this.watchState.parseFailures++;
      return;
    }
    this.onDatagram?.('in', message);
    if (
      message.length >= 4 &&
      message[0] === 0xff &&
      message[1] === 0xff &&
      message[2] === 0xff &&
      message[3] === 0xff
    ) {
      this.onOob(message);
      return;
    }
    this.onSequenced(message);
  }

  private onOob(message: Buffer): void {
    let header = '';
    let body = '';
    try {
      const parsed = parseOobPacket(message);
      header = parsed.header.replace(/\0/g, '');
      body = parsed.body.replace(/\0/g, '');
    } catch {
      this.watchState.parseFailures++;
      return;
    }
    const text = body.length === 0 ? header : `${header}\n${body}`;
    this.watchState.oobMessages.push(text);
    const pending = this.pending.findIndex((item) => item.match(header, body));
    if (pending >= 0) {
      const [item] = this.pending.splice(pending, 1);
      if (item) {
        clearTimeout(item.timer);
        item.resolve(header, body);
      }
    }
  }

  private onSequenced(message: Buffer): void {
    const assembled = this.fragments.push(message);
    if (!assembled.ok) {
      this.watchState.parseFailures++;
      return;
    }
    if (assembled.pending) return;
    this.messageAcknowledge = assembled.sequence;
    const commandSeq =
      assembled.message.length >= 4
        ? new DataView(
            assembled.message.buffer,
            assembled.message.byteOffset,
            assembled.message.byteLength,
          ).getInt32(0, true)
        : 0;
    const command = this.sentCommands.get(commandSeq) ?? '';
    const decoded = decodeServerPayload(
      assembled.message,
      this.challenge,
      assembled.sequence,
      command,
      this.protocol,
    );
    if (!decoded.ok) {
      this.watchState.parseFailures++;
      return;
    }
    const parsed = parseServerMessage(
      decoded.data,
      this.protocol,
      this.parseState,
    );
    if (!parsed.ok) {
      this.watchState.parseFailures++;
      this.noteCommands(parsed.serverCommands);
      return;
    }
    this.parseState = parsed.state;
    if (parsed.message.clientNum !== null)
      this.watchState.clientNum = parsed.message.clientNum;
    if (parsed.message.checksumFeed !== null) {
      this.checksumFeed = parsed.message.checksumFeed;
      this.haveGamestate = true;
      this.needPure = true;
    }
    if (parsed.message.serverId !== null) {
      this.serverId = parsed.message.serverId;
      this.learnedServerId = true;
      this.watchState.serverId = parsed.message.serverId;
    }
    const systemInfo = parsed.message.configstrings.get(CS_SYSTEMINFO);
    const serverInfo = parsed.message.configstrings.get(CS_SERVERINFO);
    if (systemInfo) this.watchState.systemInfo = systemInfo;
    if (serverInfo) this.watchState.serverInfo = serverInfo;
    this.noteCommands(parsed.message.serverCommands);
    for (const snapshot of parsed.message.snapshots) {
      this.watchState.snapshotCount++;
      this.watchState.serverTimes.push(snapshot.serverTimeMs);
      const receivedAtMs = Date.now();
      this.watchState.receivedAt.push(receivedAtMs);
      const samples = samplesFromSnapshot(
        snapshot.players,
        receivedAtMs,
        this.serverAlias,
      );
      for (const sample of samples) {
        this.watchState.samples.push(sample);
        this.onSample?.(sample);
      }
      this.onSnapshot?.(samples);
      if (this.cmdTime < snapshot.serverTimeMs)
        this.cmdTime = snapshot.serverTimeMs;
      const self = snapshot.clients.find(
        (client) => client.clientIndex === this.watchState.clientNum,
      );
      if (self) this.watchState.spectatorTeam = self.team;
    }
  }

  private noteCommands(
    commands: readonly { seq: number; text: string }[],
  ): void {
    for (const command of commands) {
      this.serverCommandText.set(command.seq, command.text);
      this.reliableAcknowledge = command.seq;
      this.watchState.serverCommands.push(command.text);
    }
  }

  private sendTrigger(): void {
    this.send(this.packet([], false));
  }

  private sendKeepalive(): void {
    if (this.closed || this.leaving) return;
    if (
      this.lastPacketAt !== 0 &&
      Date.now() - this.lastPacketAt >= SERVER_SILENCE_MS
    ) {
      this.droppedByServer();
      return;
    }
    if (!this.haveGamestate || !this.learnedServerId) {
      this.sendTrigger();
      return;
    }
    const commands: { seq: number; text: string }[] = [];
    if (this.needPure) {
      const seq = this.commandSeq++;
      const text = pureClientCommand(this.checksumFeed);
      commands.push({ seq, text });
      this.sentCommands.set(seq, text);
      this.needPure = false;
    }
    if (!this.sentTeam) {
      const seq = this.commandSeq++;
      commands.push({ seq, text: 'team spectator' });
      this.sentCommands.set(seq, 'team spectator');
      this.sentTeam = true;
    }
    this.cmdTime += 50;
    this.send(this.packet(commands, true));
  }

  private packet(
    commands: readonly { seq: number; text: string }[],
    move: boolean,
  ): Buffer {
    const datagram = buildClientDatagram({
      sequence: this.outgoing,
      qport: this.qport,
      challenge: this.challenge,
      serverId: this.serverId,
      messageAcknowledge: this.messageAcknowledge,
      reliableAcknowledge: this.reliableAcknowledge,
      ackedServerCommand:
        this.serverCommandText.get(this.reliableAcknowledge) ?? '',
      checksumFeed: this.checksumFeed,
      serverTime: this.cmdTime,
      commands,
      move,
    });
    this.outgoing++;
    return datagram;
  }
}

/** No datagram from the server for this long means the slot is already gone. */
const SERVER_SILENCE_MS = 15_000;

/** Retransmits of one disconnect datagram. A single lost UDP packet used to leave the bot in game. */
const DISCONNECT_SENDS = 3;
const DISCONNECT_GAP_MS = 40;

/** One connect with the pure/PB gate off. Not part of the package entry. Does not retry. */
export function connectPureProbe(options: GamePeerOptions): Promise<GamePeer> {
  return openPeer(options, false);
}

/**
 * LifeTracker files a life by `slot` and treats a different `entityNum` in
 * that bucket as another player. Each subject therefore gets every visible
 * player, including itself. `event` stays unset: death, hit, and kill codes
 * are not confirmed.
 */
export function samplesFromSnapshot(
  players: readonly EntityObservation[],
  receivedAtMs: number,
  serverAlias: string,
): Sample[] {
  const samples: Sample[] = [];
  for (const subject of players) {
    for (const player of players) {
      samples.push(
        toSample(player, receivedAtMs, serverAlias, subject.clientNum),
      );
    }
  }
  return samples;
}

function toSample(
  player: EntityObservation,
  receivedAtMs: number,
  serverAlias: string,
  slot: number,
): Sample {
  return {
    serverTimeMs: player.serverTimeMs,
    receivedAtMs,
    serverAlias,
    slot,
    entityNum: player.entityNum,
    origin: { x: player.origin[0], y: player.origin[1], z: player.origin[2] },
    velocity: {
      x: player.velocity[0],
      y: player.velocity[1],
      z: player.velocity[2],
    },
    viewangles: { pitch: player.viewangles[0], yaw: player.viewangles[1] },
    weapon: player.weapon,
  };
}

function emptyStatus(): StatusInfo {
  return {
    protocol: null,
    sv_pure: null,
    sv_punkbuster: null,
    sv_fps: null,
    keys: {},
  };
}
