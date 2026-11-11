import { PassThrough } from 'node:stream';
import {
  ConnectRefusedError,
  samplesFromSnapshot,
  type EntityObservation,
} from '@cod2admin/game-client';
import type { Sample } from '@cod2admin/player-watch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWatchChild, type ChildConnectOptions } from './child.js';

const children: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    await child.stop();
  }
  vi.useRealTimers();
});

describe('watch child snapshots', () => {
  it('ends a slot that leaves, with the neighbor filed under that slot', async () => {
    const seen = await runSnapshots(async (snap, send) => {
      for (let serverTimeMs = 0; serverTimeMs < 1100; serverTimeMs += 50) {
        snap([player(4, serverTimeMs, 90, 400)]);
      }
      snap([player(4, 1100, 0, 400), player(2, 1100, 0, 0, [100, 0, 0])]);
      snap([]);
      send({ type: 'confirm', serverAlias: 'default', mapName: null });
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

  it('ends a held absence as map when the rename arrives after the gap', async () => {
    const seen = await runSnapshots(async (snap, send, read) => {
      send({ type: 'map', serverAlias: 'default', mapName: 'mp_toujane' });
      await new Promise((resolve) => setImmediate(resolve));
      snap([player(4, 0, 0, 0)]);
      snap([]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(read()).toEqual([]);
      send({ type: 'map', serverAlias: 'default', mapName: 'mp_carentan' });
    });
    expect(seen.map((row) => [row['slot'], row['endReason']])).toEqual([
      [4, 'map'],
    ]);
  });

  it('ends a held absence as disconnect when the same map is confirmed', async () => {
    const seen = await runSnapshots(async (snap, send, read) => {
      send({ type: 'map', serverAlias: 'default', mapName: 'mp_toujane' });
      await new Promise((resolve) => setImmediate(resolve));
      snap([player(4, 0, 0, 0)]);
      snap([]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(read()).toEqual([]);
      send({ type: 'confirm', serverAlias: 'default', mapName: 'mp_toujane' });
    });
    expect(seen.map((row) => [row['slot'], row['endReason']])).toEqual([
      [4, 'disconnect'],
    ]);
  });

  it('ends a held absence as disconnect after the status window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    child.snap(samplesFromSnapshot([player(4, 0, 0, 0)], 0, 'default'));
    child.snap([]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(parseLines(child.lines)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      parseLines(child.lines).map((row) => [row['slot'], row['endReason']]),
    ).toEqual([[4, 'disconnect']]);
  });

  it('reconnects when the spectator name changes and keeps the peer otherwise', async () => {
    const names: string[] = [];
    const dropped: string[] = [];
    const child = startChild(async (options) => {
      names.push(options.name ?? '');
      return {
        disconnect() {
          dropped.push(options.name ?? '');
        },
        run() {},
      };
    });
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({ type: 'hello', servers: [server('default')] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(names).toEqual(['AdminWatch']);

    send({ type: 'reload', servers: [server('default')] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(names).toEqual(['AdminWatch']);
    expect(dropped).toEqual([]);

    send({
      type: 'reload',
      servers: [{ ...server('default'), spectatorName: 'Spotter' }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(dropped).toEqual(['AdminWatch']);
    expect(names).toEqual(['AdminWatch', 'Spotter']);
  });

  it('keeps an in-flight connect when the same server is reloaded', async () => {
    let release: (peer: { disconnect(): void; run(): void }) => void = () =>
      undefined;
    const gate = new Promise<{ disconnect(): void; run(): void }>((resolve) => {
      release = resolve;
    });
    const names: string[] = [];
    const dropped: string[] = [];
    const child = startChild((options) => {
      names.push(options.name ?? '');
      return gate.then(() => ({
        disconnect() {
          dropped.push(options.name ?? '');
        },
        run() {},
      }));
    });
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({ type: 'hello', servers: [server('default')] });
    await new Promise((resolve) => setImmediate(resolve));
    send({ type: 'reload', servers: [server('default')] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(names).toEqual(['AdminWatch']);
    release({ disconnect() {}, run() {} });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(names).toEqual(['AdminWatch']);
    expect(dropped).toEqual([]);
  });

  it('leaves the game before the process exits', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let left = false;
    const stdin = new PassThrough();
    const child = createWatchChild({
      stdin,
      stdout: { write: () => true },
      exitOnStop: true,
      connect: async () => ({
        disconnect() {
          return gate.then(() => {
            left = true;
          });
        },
        run() {},
      }),
    });
    children.push(child);
    let stopped: Promise<void> = Promise.resolve();
    try {
      stdin.write(
        `${JSON.stringify({ type: 'hello', servers: [server('default')] })}\n`,
      );
      await new Promise((resolve) => setImmediate(resolve));
      stopped = child.stop();
      await new Promise((resolve) => setImmediate(resolve));
      expect(left).toBe(false);
      expect(exit).not.toHaveBeenCalled();
      release?.();
      await stopped;
      expect(left).toBe(true);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      release?.();
      await stopped;
      exit.mockRestore();
    }
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

  it('reconnects after the server stops answering', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls: string[] = [];
    let drop: (() => void) | undefined;
    const child = startChild(async (options) => {
      calls.push(options.serverAlias);
      drop = options.onDropped;
      return { disconnect() {}, run() {} };
    });
    child.stdin.write(
      `${JSON.stringify({ type: 'hello', servers: [server('default')] })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(['default']);
    drop?.();
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual(['default']);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['default', 'default']);
  });

  it('holds the next map scores until the parent names that map', async () => {
    let hooks: ChildConnectOptions | undefined;
    const child = startChild(async (options) => {
      hooks = options;
      return { disconnect() {}, run() {} };
    });
    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const scores = (): Record<string, unknown>[] =>
      parseLines(child.lines).filter((row) => row['type'] === 'scores');
    send({ type: 'hello', servers: [server('default')] });
    await new Promise((resolve) => setImmediate(resolve));
    if (!hooks?.onGamestate || !hooks.onServerCommand || !hooks.onClients) {
      throw new Error('child did not connect');
    }
    hooks.onGamestate({ mapName: 'mp_toujane', axis: 0, allies: 0 });
    expect(scores()).toEqual([]);
    send({ type: 'map', serverAlias: 'default', mapName: 'mp_toujane' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(scores()).toEqual([
      {
        type: 'scores',
        serverAlias: 'default',
        mapName: 'mp_toujane',
        axis: 0,
        allies: 0,
      },
    ]);
    hooks.onServerCommand('d 5 8');
    hooks.onServerCommand('d 6 2');
    hooks.onClients([
      { clientIndex: 1, team: 2 },
      { clientIndex: 3, team: 1 },
    ]);
    expect(
      parseLines(child.lines).filter((row) => row['type'] === 'teams'),
    ).toEqual([
      {
        type: 'teams',
        serverAlias: 'default',
        teams: [
          { slot: 1, team: 2 },
          { slot: 3, team: 1 },
        ],
      },
    ]);
    hooks.onGamestate({ mapName: 'mp_carentan', axis: 0, allies: 0 });
    expect(scores().some((row) => row['mapName'] === 'mp_carentan')).toBe(
      false,
    );
    expect(scores().at(-1)).toMatchObject({
      mapName: 'mp_toujane',
      axis: 8,
      allies: 2,
    });
    hooks.onServerCommand('d 6 1');
    expect(scores().some((row) => row['mapName'] === 'mp_carentan')).toBe(
      false,
    );
    send({ type: 'map', serverAlias: 'default', mapName: 'mp_carentan' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(scores().at(-1)).toEqual({
      type: 'scores',
      serverAlias: 'default',
      mapName: 'mp_carentan',
      axis: 0,
      allies: 1,
    });
  });
});

async function runSnapshots(
  drive: (
    snap: (players: EntityObservation[]) => void,
    send: (message: unknown) => void,
    read: () => Record<string, unknown>[],
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
  const read = (): Record<string, unknown>[] => parseLines(child.lines);
  await drive(snap, send, read);
  await new Promise((resolve) => setImmediate(resolve));
  return read();
}

function parseLines(lines: string[]): Record<string, unknown>[] {
  return lines
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function startChild(
  connect: (options: ChildConnectOptions) => Promise<{
    disconnect(): void | Promise<void>;
    run(): void;
  }>,
): {
  stdin: PassThrough;
  lines: string[];
  snap?: (samples: Sample[]) => void;
  stop(): Promise<void>;
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
