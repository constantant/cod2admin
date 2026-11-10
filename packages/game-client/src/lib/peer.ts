import dgram from 'node:dgram';
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
  timeoutMs?: number;
  onDatagram?: (direction: 'in' | 'out', bytes: Buffer) => void;
}

export interface WatchResult {
  serverCommands: string[];
  oobMessages: string[];
  snapshotCount: number;
  /** Server time of each parsed snapshot, in order. */
  serverTimes: number[];
  /** Local receive time of each parsed snapshot. */
  receivedAt: number[];
  samples: EntityObservation[];
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
 * Spectator-only peer. Sends no movement buttons and no private-slot password.
 * `connect` refuses unless getstatus has `sv_pure` and `sv_punkbuster` equal to `0`.
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
  private readonly onDatagram?: GamePeerOptions['onDatagram'];
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
  private sentTeam = false;
  private cmdTime = 50;
  private closed = false;
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
    this.onDatagram = options.onDatagram;
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
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
    const peer = new GamePeer(options, emptyStatus(), 0, socket, 0);
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

  disconnect(): void {
    if (this.closed) return;
    try {
      const packet = buildDisconnectDatagram({
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
      this.send(packet);
    } catch {
      // A failed disconnect packet still closes the socket.
    }
    this.close();
  }

  private adopt(protocol: number, challenge: number): void {
    this.protocol = protocol;
    this.challenge = challenge;
    this.fragments = new FragmentAssembler(protocol);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(new Error('socket closed'));
    }
    this.socket.close();
  }

  private send(packet: Buffer): void {
    if (this.closed) return;
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

  private onMessage(message: Buffer, rinfo: dgram.RemoteInfo): void {
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
      this.watchState.receivedAt.push(Date.now());
      this.watchState.samples.push(...snapshot.players);
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
    if (!this.haveGamestate || !this.learnedServerId) {
      this.sendTrigger();
      return;
    }
    const commands: { seq: number; text: string }[] = [];
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

/** One connect with the pure/PB gate off. Not part of the package entry. Does not retry. */
export function connectPureProbe(options: GamePeerOptions): Promise<GamePeer> {
  return openPeer(options, false);
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
