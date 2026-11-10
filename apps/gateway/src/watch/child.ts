import { createInterface } from 'node:readline';
import { GamePeer } from '@cod2admin/game-client';
import {
  LifeTracker,
  type LifeFeatures,
  type Sample,
} from '@cod2admin/player-watch';
import {
  parseParentMessage,
  type HelloServer,
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
  gSpeed: number | null;
  peer?: GamePeer;
  tracker: LifeTracker;
  slots: Set<number>;
  startedAt: Map<number, number>;
}

const connections = new Map<string, Connection>();
let generation = 0;
let stopped = false;
let chain: Promise<void> = Promise.resolve();

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  chain = chain
    .then(() => onLine(line))
    .catch((error: unknown) => {
      console.error(
        `watch child: ${error instanceof Error ? error.message : 'line failed'}`,
      );
    });
});
process.stdin.on('end', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());

async function onLine(line: string): Promise<void> {
  const message = parseParentMessage(line);
  if (!message) {
    return;
  }
  await apply(message);
}

async function apply(message: ParentMessage): Promise<void> {
  const gen = ++generation;
  const next = new Map(message.servers.map((server) => [server.alias, server]));
  for (const [alias, connection] of connections) {
    if (next.has(alias)) {
      continue;
    }
    drop(connection, 'disconnect');
    connections.delete(alias);
  }
  for (const server of message.servers) {
    if (gen !== generation) {
      return;
    }
    const current = connections.get(server.alias);
    if (
      current?.peer &&
      current.host === server.host &&
      current.port === server.port &&
      current.gSpeed === server.gSpeed
    ) {
      continue;
    }
    await connectServer(server, gen);
  }
}

async function connectServer(server: HelloServer, gen: number): Promise<void> {
  const previous = connections.get(server.alias);
  if (previous) {
    drop(previous, 'disconnect');
    connections.delete(server.alias);
  }
  const connection: Connection = {
    alias: server.alias,
    host: server.host,
    port: server.port,
    gSpeed: server.gSpeed,
    tracker: new LifeTracker(null, server.gSpeed),
    slots: new Set(),
    startedAt: new Map(),
  };
  connections.set(server.alias, connection);
  try {
    // Spectator userinfo only. `server.password` is not read and not logged.
    const peer = await GamePeer.connect({
      host: server.host,
      port: server.port,
      serverAlias: server.alias,
      name: server.spectatorName,
      onSample: (sample) => {
        if (gen !== generation) {
          return;
        }
        onSample(server.alias, sample);
      },
    });
    if (gen !== generation || stopped) {
      peer.disconnect();
      if (connections.get(server.alias) === connection) {
        connections.delete(server.alias);
      }
      return;
    }
    connection.peer = peer;
    peer.run();
  } catch (error) {
    if (connections.get(server.alias) === connection) {
      connections.delete(server.alias);
    }
    console.error(
      `watch child: ${server.alias} connect failed: ${
        error instanceof Error ? error.message : 'error'
      }`,
    );
  }
}

function onSample(alias: string, sample: Sample): void {
  const connection = connections.get(alias);
  if (!connection) {
    return;
  }
  if (!connection.startedAt.has(sample.slot)) {
    connection.startedAt.set(sample.slot, sample.receivedAtMs);
  }
  connection.slots.add(sample.slot);
  const closed = connection.tracker.push(sample);
  if (closed) {
    emitLife(connection, closed);
  }
}

function drop(connection: Connection, reason: 'disconnect' | 'map'): void {
  for (const slot of connection.slots) {
    const closed = connection.tracker.end(slot, reason);
    if (closed) {
      emitLife(connection, closed);
    }
  }
  connection.slots.clear();
  connection.peer?.disconnect();
  connection.peer = undefined;
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
  process.stdout.write(
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

function shutdown(): void {
  if (stopped) {
    return;
  }
  stopped = true;
  generation += 1;
  for (const connection of connections.values()) {
    drop(connection, 'disconnect');
  }
  connections.clear();
  process.exit(0);
}
