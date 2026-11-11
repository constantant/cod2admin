import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { ConnectRefusedError, GamePeer } from '@cod2admin/game-client';
import {
  LifeTracker,
  type LifeFeatures,
  type Sample,
} from '@cod2admin/player-watch';
import {
  parseParentMessage,
  type ConfirmMessage,
  type HelloServer,
  type MapMessage,
  type ParentMessage,
} from './ipc.js';

/**
 * Collects samples and writes life features. It does not open Postgres and it
 * does not put a private password into userinfo or onto stdout.
 */
interface Connection {
  alias: string;
  host: string;
  port: number;
  /** Sent in userinfo only while connecting, so a rename has to open a new peer. */
  spectatorName: string;
  gSpeed: number | null;
  mapName: string | null;
  /** Snapshots stay live while this matches the hello generation. */
  liveGen: number;
  peer?: PeerHandle;
  tracker: LifeTracker;
  slots: Set<number>;
  startedAt: Map<number, number>;
  pendingAbsent: Set<number>;
  absenceTimer?: ReturnType<typeof setTimeout>;
  attempt: number;
  retry?: ReturnType<typeof setTimeout>;
}

interface PeerHandle {
  /** Resolves after the leave packet is queued. A sync mock is fine. */
  disconnect(): void | Promise<void>;
  run(): void;
}

export interface ChildConnectOptions {
  host: string;
  port: number;
  serverAlias: string;
  name?: string;
  onSnapshot: (samples: Sample[]) => void;
  /** The peer already closed. Reconnect on the normal backoff. */
  onDropped?: () => void;
}

export interface WatchChildOptions {
  stdin: Readable;
  stdout: { write(chunk: string): unknown };
  connect?: (options: ChildConnectOptions) => Promise<PeerHandle>;
  /** Production child exits when stdin closes. Tests leave the process up. */
  exitOnStop?: boolean;
}

const BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000];
/** Same window as a fresh parent status. A held absence ends if nothing arrives. */
const ABSENCE_MS = 10_000;

export function createWatchChild(options: WatchChildOptions): {
  stop(): Promise<void>;
} {
  const connectPeer = options.connect ?? defaultConnect;
  const connections = new Map<string, Connection>();
  let generation = 0;
  let stopped = false;
  let stopping: Promise<void> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const lines = createInterface({ input: options.stdin });
  const onLine = (line: string): void => {
    chain = chain
      .then(() => handleLine(line))
      .catch((error: unknown) => {
        console.error(
          `watch child: ${error instanceof Error ? error.message : 'line failed'}`,
        );
      });
  };
  lines.on('line', onLine);

  function handleLine(line: string): Promise<void> {
    const message = parseParentMessage(line);
    if (!message) {
      return Promise.resolve();
    }
    if (message.type === 'map') {
      applyMap(message);
      return Promise.resolve();
    }
    if (message.type === 'confirm') {
      applyConfirm(message);
      return Promise.resolve();
    }
    return apply(message);
  }

  async function apply(
    message: Exclude<ParentMessage, MapMessage | ConfirmMessage>,
  ): Promise<void> {
    const gen = ++generation;
    const next = new Map(
      message.servers.map((server) => [server.alias, server]),
    );
    for (const [alias, connection] of connections) {
      if (next.has(alias)) {
        continue;
      }
      await drop(connection, 'disconnect');
      connections.delete(alias);
    }
    for (const server of message.servers) {
      if (gen !== generation) {
        return;
      }
      const current = connections.get(server.alias);
      // The userinfo name is fixed at connect. A new name drops this peer.
      // A reload while connect() is still in flight has no peer yet. Starting
      // another connect here disconnects the first socket as soon as it
      // lands, which the server logs as EXE_DISCONNECTED.
      if (
        current &&
        current.host === server.host &&
        current.port === server.port &&
        current.gSpeed === server.gSpeed &&
        current.spectatorName === server.spectatorName
      ) {
        current.liveGen = gen;
        if (server.mapName) {
          adoptMap(current, server.mapName);
        }
        continue;
      }
      await connectServer(server, gen);
    }
  }

  async function connectServer(
    server: HelloServer,
    gen: number,
  ): Promise<void> {
    const previous = connections.get(server.alias);
    if (previous) {
      await drop(previous, 'disconnect');
      connections.delete(server.alias);
    }
    const mapName = server.mapName ?? null;
    const connection: Connection = {
      alias: server.alias,
      host: server.host,
      port: server.port,
      spectatorName: server.spectatorName,
      gSpeed: server.gSpeed,
      mapName,
      liveGen: gen,
      tracker: new LifeTracker(mapName, server.gSpeed),
      slots: new Set(),
      startedAt: new Map(),
      pendingAbsent: new Set(),
      attempt: 0,
    };
    connections.set(server.alias, connection);
    await openPeer(connection, server);
  }

  async function openPeer(
    connection: Connection,
    server: HelloServer,
  ): Promise<void> {
    let current: PeerHandle | undefined;
    try {
      // Spectator userinfo only. `server.password` is not read and not logged.
      const peer = await connectPeer({
        host: server.host,
        port: server.port,
        serverAlias: server.alias,
        name: server.spectatorName,
        onSnapshot: (samples) => {
          if (
            connection.liveGen !== generation ||
            current === undefined ||
            connections.get(server.alias) !== connection
          ) {
            return;
          }
          ingest(connection, samples);
        },
        onDropped: () => {
          if (
            stopped ||
            connections.get(server.alias) !== connection ||
            current === undefined ||
            connection.peer !== current
          ) {
            return;
          }
          connection.peer = undefined;
          console.error(
            `watch child: ${server.alias} lost the server, reconnecting`,
          );
          scheduleRetry(connection, server);
        },
      });
      if (stopped || connections.get(server.alias) !== connection) {
        await peer.disconnect();
        return;
      }
      current = peer;
      connection.attempt = 0;
      connection.peer = peer;
      peer.run();
    } catch (error) {
      if (connections.get(server.alias) !== connection) {
        return;
      }
      console.error(
        `watch child: ${server.alias} connect failed: ${
          error instanceof Error ? error.message : 'error'
        }`,
      );
      // Pure and PunkBuster refusals stay down until the parent syncs again.
      if (error instanceof ConnectRefusedError) {
        clearRetry(connection);
        connections.delete(server.alias);
        return;
      }
      scheduleRetry(connection, server);
    }
  }

  function scheduleRetry(connection: Connection, server: HelloServer): void {
    if (stopped || connections.get(server.alias) !== connection) {
      return;
    }
    const delay =
      BACKOFF_MS[Math.min(connection.attempt, BACKOFF_MS.length - 1)] ?? 30_000;
    connection.attempt += 1;
    const timer = setTimeout(() => {
      connection.retry = undefined;
      if (stopped || connections.get(server.alias) !== connection) {
        return;
      }
      void openPeer(connection, server);
    }, delay);
    timer.unref();
    connection.retry = timer;
  }

  /** The first real name replaces the tracker and leaves open slots open. */
  function adoptMap(connection: Connection, mapName: string): void {
    if (connection.mapName !== null || mapName.length === 0) {
      return;
    }
    connection.mapName = mapName;
    connection.tracker = new LifeTracker(mapName, connection.gSpeed);
  }

  function applyMap(message: MapMessage): void {
    const connection = connections.get(message.serverAlias);
    const next = message.mapName;
    if (!connection || next === null || connection.mapName === next) {
      return;
    }
    if (connection.mapName === null) {
      adoptMap(connection, next);
      return;
    }
    clearAbsenceTimer(connection);
    connection.pendingAbsent.clear();
    for (const slot of [...connection.slots]) {
      const closed = connection.tracker.end(slot, 'map');
      if (closed) {
        emitLife(connection, closed);
      }
    }
    connection.slots.clear();
    connection.startedAt.clear();
    connection.mapName = next;
    connection.tracker = new LifeTracker(next, connection.gSpeed);
  }

  function ingest(connection: Connection, samples: readonly Sample[]): void {
    const present = new Set<number>();
    for (const sample of samples) {
      present.add(sample.slot);
      connection.pendingAbsent.delete(sample.slot);
      if (!connection.startedAt.has(sample.slot)) {
        connection.startedAt.set(sample.slot, sample.receivedAtMs);
      }
      connection.slots.add(sample.slot);
      const closed = connection.tracker.push(sample);
      if (closed) {
        emitLife(connection, closed);
      }
    }
    let missing = false;
    for (const slot of connection.slots) {
      if (present.has(slot)) {
        continue;
      }
      connection.pendingAbsent.add(slot);
      missing = true;
    }
    if (connection.pendingAbsent.size === 0) {
      clearAbsenceTimer(connection);
      return;
    }
    if (missing) {
      scheduleAbsence(connection);
    }
  }

  function applyConfirm(message: ConfirmMessage): void {
    const connection = connections.get(message.serverAlias);
    if (!connection || connection.mapName !== message.mapName) {
      return;
    }
    commitAbsence(connection);
  }

  function scheduleAbsence(connection: Connection): void {
    if (connection.absenceTimer !== undefined) {
      return;
    }
    const timer = setTimeout(() => {
      connection.absenceTimer = undefined;
      if (connections.get(connection.alias) !== connection) {
        return;
      }
      commitAbsence(connection);
    }, ABSENCE_MS);
    timer.unref();
    connection.absenceTimer = timer;
  }

  function commitAbsence(connection: Connection): void {
    clearAbsenceTimer(connection);
    for (const slot of [...connection.pendingAbsent]) {
      connection.pendingAbsent.delete(slot);
      if (!connection.slots.has(slot)) {
        continue;
      }
      const closed = connection.tracker.end(slot, 'disconnect');
      if (closed) {
        emitLife(connection, closed);
      } else {
        connection.slots.delete(slot);
        connection.startedAt.delete(slot);
      }
    }
  }

  function clearAbsenceTimer(connection: Connection): void {
    if (connection.absenceTimer === undefined) {
      return;
    }
    clearTimeout(connection.absenceTimer);
    connection.absenceTimer = undefined;
  }

  async function drop(
    connection: Connection,
    reason: 'disconnect' | 'map',
  ): Promise<void> {
    clearAbsenceTimer(connection);
    connection.pendingAbsent.clear();
    clearRetry(connection);
    for (const slot of [...connection.slots]) {
      const closed = connection.tracker.end(slot, reason);
      if (closed) {
        emitLife(connection, closed);
      }
    }
    connection.slots.clear();
    const peer = connection.peer;
    connection.peer = undefined;
    await peer?.disconnect();
  }

  function emitLife(connection: Connection, features: LifeFeatures): void {
    const started = connection.startedAt.get(features.slot) ?? Date.now();
    connection.startedAt.delete(features.slot);
    connection.slots.delete(features.slot);
    const picked: Record<string, number> = {};
    for (const key of [
      'snapOnAcquire',
      'firedWhileLookingAway',
      'viewErrorAtHit',
      'timeToDamageMs',
      'angularSpeedP95',
      'speedOverG',
    ] as const) {
      const value = features[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        picked[key] = value;
      }
    }
    options.stdout.write(
      `${JSON.stringify({
        type: 'life',
        serverAlias: connection.alias,
        slot: features.slot,
        endReason: features.endReason,
        strippedName: '',
        startedAtMs: started,
        endedAtMs: Date.now(),
        features: picked,
      })}\n`,
    );
  }

  function shutdown(): Promise<void> {
    if (stopping) {
      return stopping;
    }
    stopped = true;
    generation += 1;
    lines.close();
    const pending = [...connections.values()];
    connections.clear();
    stopping = Promise.all(
      pending.map((connection) => drop(connection, 'disconnect')),
    ).then(() => {
      if (options.exitOnStop) {
        process.exit(0);
      }
    });
    return stopping;
  }

  const onStop = (): void => {
    void shutdown();
  };
  options.stdin.on('end', onStop);
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);

  return {
    stop() {
      options.stdin.off('end', onStop);
      process.off('SIGTERM', onStop);
      process.off('SIGINT', onStop);
      return shutdown();
    },
  };
}

async function defaultConnect(
  options: ChildConnectOptions,
): Promise<PeerHandle> {
  return GamePeer.connect({
    host: options.host,
    port: options.port,
    serverAlias: options.serverAlias,
    name: options.name,
    onSnapshot: options.onSnapshot,
    onDropped: options.onDropped,
  });
}

function clearRetry(connection: Connection): void {
  if (!connection.retry) {
    return;
  }
  clearTimeout(connection.retry);
  connection.retry = undefined;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  createWatchChild({
    stdin: process.stdin,
    stdout: process.stdout,
    exitOnStop: true,
  });
}
