import { PassThrough } from 'node:stream';
import {
  ConnectRefusedError,
  samplesFromSnapshot,
  type EntityObservation,
} from '@cod2admin/game-client';
import type { Sample } from '@cod2admin/player-watch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWatchChild, type ChildConnectOptions } from './child.js';

const children: { stop(): void }[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.stop();
  }
  vi.useRealTimers();
});

describe('watch child snapshots', () => {
  it('ends a slot that leaves, with the neighbor filed under that slot', async () => {
    const seen = await runSnapshots(async (snap) => {
      for (let serverTimeMs = 0; serverTimeMs < 1100; serverTimeMs += 50) {
        snap([player(4, serverTimeMs, 90, 400)]);
      }
      snap([player(4, 1100, 0, 400), player(2, 1100, 0, 0, [100, 0, 0])]);
      snap([]);
    });
    const life = seen.find((row) => row['slot'] === 4);
    expect(life).toMatchObject({ type: 'life', endReason: 'disconnect' });
    expect(life?.['features']).toEqual(
      expect.objectContaining({
        snapOnAcquire: expect.any(Number),
        speedOverG: expect.any(Number),
      }),
    );
    expect(seen.every((row) => row['event'] === undefined)).toBe(true);
  });

  it('adopts the first map and ends a later change as map', async () => {
    const seen = await runSnapshots(async (snap, send) => {
      snap([player(4, 0, 0, 0)]);
      send({ type: 'map', serverAlias: 'default', mapName: 'mp_toujane' });
      await new Promise((resolve) => setImmediate(resolve));
      snap([player(4, 50, 0, 0)]);
      snap([]);
      send({ type: 'map', serverAlias: 'default', mapName: 'mp_carentan' });
    });
    expect(seen.map((row) => [row['slot'], row['endReason']])).toEqual([
      [4, 'map'],
    ]);
  });

  it('retries a timeout per server and does not retry a pure refusal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls: string[] = [];
    const child = startChild(async (options) => {
      calls.push(options.serverAlias);
      if (options.serverAlias === 'pure') {
        throw new ConnectRefusedError('sv_pure is "1"', {
          protocol: 118,
          sv_pure: '1',
          sv_punkbuster: '0',
          sv_fps: null,
          keys: {},
        });
      }
      throw new Error('timeout');
    });
    child.stdin.write(
      `${JSON.stringify({
        type: 'hello',
        servers: [server('default'), server('pure')],
      })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.filter((alias) => alias === 'pure')).toEqual(['pure']);
    expect(calls.filter((alias) => alias === 'default')).toEqual(['default']);

    await vi.advanceTimersByTimeAsync(999);
    expect(calls.filter((alias) => alias === 'default')).toEqual(['default']);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.filter((alias) => alias === 'default')).toEqual([
      'default',
      'default',
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.filter((alias) => alias === 'pure')).toEqual(['pure']);
    expect(calls.filter((alias) => alias === 'default').length).toBeGreaterThan(
      2,
    );
  });
});

async function runSnapshots(
  drive: (
    snap: (players: EntityObservation[]) => void,
    send: (message: unknown) => void,
  ) => Promise<void>,
): Promise<Record<string, unknown>[]> {
  const child = startChild(async (options) => {
    child.snap = options.onSnapshot;
    return { disconnect() {}, run() {} };
  });
  child.stdin.write(
    `${JSON.stringify({ type: 'hello', servers: [server('default')] })}\n`,
  );
  await new Promise((resolve) => setImmediate(resolve));
  if (!child.snap) {
    throw new Error('child did not connect');
  }
  const snap = (players: EntityObservation[]): void => {
    child.snap?.(
      samplesFromSnapshot(players, players[0]?.serverTimeMs ?? 0, 'default'),
    );
  };
  const send = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  await drive(snap, send);
  await new Promise((resolve) => setImmediate(resolve));
  return child.lines
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function startChild(
  connect: (options: ChildConnectOptions) => Promise<{
    disconnect(): void;
    run(): void;
  }>,
): {
  stdin: PassThrough;
  lines: string[];
  snap?: (samples: Sample[]) => void;
  stop(): void;
} {
  const stdin = new PassThrough();
  const lines: string[] = [];
  const handle = createWatchChild({
    stdin,
    stdout: {
      write(chunk: string) {
        lines.push(String(chunk));
        return true;
      },
    },
    connect,
  });
  const child = {
    stdin,
    lines,
    snap: undefined as ((samples: Sample[]) => void) | undefined,
    stop: () => handle.stop(),
  };
  children.push(child);
  return child;
}

function server(alias: string): Record<string, unknown> {
  return {
    alias,
    host: '127.0.0.1',
    port: alias === 'pure' ? 28961 : 28960,
    spectatorName: 'AdminWatch',
    protocol: 118,
    gSpeed: 190,
  };
}

function player(
  slot: number,
  serverTimeMs: number,
  yaw: number,
  vx: number,
  origin: readonly [number, number, number] = [0, 0, 0],
): EntityObservation {
  return {
    serverTimeMs,
    entityNum: slot,
    eType: 1,
    clientNum: slot,
    origin,
    velocity: [vx, 0, 0],
    viewangles: [0, yaw, 0],
    weapon: 0,
  };
}
