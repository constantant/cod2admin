/**
 * Manual dev-server spike. Not part of vitest and not part of the library build.
 * Does not set sv_privateclients or sv_privatepassword. sv_pure 0 is a raw OOB
 * rcon only after the rejection text is stored, and finally restores sv_pure 1
 * when this run was the one that lowered it.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOobPacket, parseOobPacket } from '@cod2admin/rcon-client';
import type { Sample } from '@cod2admin/player-watch';
import { connectPureProbe, GamePeer, type WatchResult } from './lib/peer.js';
import {
  buildGetstatusPacket,
  parseStatusBody,
  type StatusInfo,
} from './lib/wire.js';

const host = '127.0.0.1';
const port = 28960;
const password =
  process.env['COD2_RCON_PASSWORD'] ?? 'dev_rcon_password_change_me';
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

async function query(packet: Buffer, timeoutMs = 3000): Promise<string> {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, host, () => resolve());
  });
  const reply = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    socket.once('message', (msg, rinfo) => {
      if (rinfo.address !== host || rinfo.port !== port) return;
      clearTimeout(timer);
      resolve(msg);
    });
    socket.send(packet, port, host);
  }).finally(() => socket.close());
  const parsed = parseOobPacket(reply);
  return parsed.body.replace(/\0/g, '');
}

function save(name: string, bytes: Buffer): void {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, name), bytes);
}

function spread(samples: Sample[]): {
  enemies: number;
  areas: number;
  originChanged: number;
  anglesChanged: number;
} {
  const byEntity = new Map<number, Sample[]>();
  for (const sample of samples) {
    const list = byEntity.get(sample.entityNum) ?? [];
    list.push(sample);
    byEntity.set(sample.entityNum, list);
  }
  let originChanged = 0;
  let anglesChanged = 0;
  const centers: { x: number; y: number }[] = [];
  for (const list of byEntity.values()) {
    const first = list[0];
    const last = list[list.length - 1];
    if (!first?.origin || !last?.origin) continue;
    const moved = Math.hypot(
      last.origin.x - first.origin.x,
      last.origin.y - first.origin.y,
    );
    const turned =
      Math.abs((last.viewangles?.yaw ?? 0) - (first.viewangles?.yaw ?? 0)) +
      Math.abs((last.viewangles?.pitch ?? 0) - (first.viewangles?.pitch ?? 0));
    if (moved > 64) originChanged++;
    if (turned > 5) anglesChanged++;
    centers.push({ x: last.origin.x, y: last.origin.y });
  }
  let areas = 0;
  const used = new Set<number>();
  for (let i = 0; i < centers.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    areas++;
    const origin = centers[i];
    if (!origin) continue;
    for (let j = i + 1; j < centers.length; j++) {
      const other = centers[j];
      if (!other) continue;
      if (Math.hypot(other.x - origin.x, other.y - origin.y) < 512) used.add(j);
    }
  }
  return { enemies: byEntity.size, areas, originChanged, anglesChanged };
}

function intervals(times: number[]): number | null {
  if (times.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++)
    deltas.push((times[i] ?? 0) - (times[i - 1] ?? 0));
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] ?? null;
}

async function probe(
  label: string,
  gate: boolean,
): Promise<WatchResult & { error?: string }> {
  const captured: Buffer[] = [];
  const open = gate ? GamePeer.connect.bind(GamePeer) : connectPureProbe;
  try {
    const peer = await open({
      host,
      port,
      timeoutMs: 4000,
      onDatagram: (direction, bytes) => {
        if (direction === 'in' && captured.length < 4)
          captured.push(Buffer.from(bytes));
      },
    });
    const watched = await peer.watch(label === 'pure-still-1' ? 8000 : 20000);
    peer.disconnect();
    captured.forEach((bytes, index) => save(`${label}-${index}.bin`, bytes));
    return watched;
  } catch (error) {
    return {
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
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function rejectionStored(
  run: { serverCommands: string[]; oobMessages: string[] } | null,
): boolean {
  if (!run) return false;
  const text = [...run.serverCommands, ...run.oobMessages].join('\n');
  return (
    text.includes('EXE_CANNOTVALIDATEPURECLIENT') ||
    text.includes('EXE_UNPURECLIENTDETECTED')
  );
}

function summarize(
  status: StatusInfo | null,
  pureRun: Awaited<ReturnType<typeof probe>> | null,
  parseRun: Awaited<ReturnType<typeof probe>> | null,
) {
  const movement = spread(parseRun?.samples ?? []);
  const weapons = [
    ...new Set((parseRun?.samples ?? []).map((sample) => sample.weapon)),
  ];
  return {
    date: new Date().toISOString().slice(0, 10),
    target: `${host}:${port}`,
    status,
    pureRejection: pureRun
      ? {
          error: pureRun.error ?? null,
          serverCommands: pureRun.serverCommands,
          oob: pureRun.oobMessages,
          snapshots: pureRun.snapshotCount,
          parseFailures: pureRun.parseFailures,
        }
      : null,
    parseRun: parseRun
      ? {
          error: parseRun.error ?? null,
          snapshots: parseRun.snapshotCount,
          parseFailures: parseRun.parseFailures,
          spectatorTeam: parseRun.spectatorTeam,
          clientNum: parseRun.clientNum,
          serverId: parseRun.serverId,
          intervalMs: intervals(parseRun.receivedAt),
          movement,
          weapons,
          confirmedAimFeatures: 0,
          serverCommands: parseRun.serverCommands.slice(0, 12),
          systemInfo: parseRun.systemInfo,
        }
      : null,
  };
}

async function main(): Promise<void> {
  let lowered = false;
  try {
    let status: StatusInfo;
    try {
      status = parseStatusBody(await query(buildGetstatusPacket()));
    } catch (error) {
      const failure = {
        date: new Date().toISOString().slice(0, 10),
        target: `${host}:${port}`,
        unreachable: error instanceof Error ? error.message : String(error),
        confirmedAimFeatures: 0,
      };
      process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
      return;
    }
    const pureRun =
      status.sv_pure === '0' ? null : await probe('pure-still-1', false);
    // Lower pure only after the rejection text is already in pureRun. A server that
    // was already 0 is left alone, and finally does not force it back to 1.
    if (status.sv_pure !== '0' && rejectionStored(pureRun)) {
      lowered = true;
      try {
        await query(buildOobPacket(`rcon ${password} sv_pure 0`));
      } catch (error) {
        process.stderr.write(
          `rcon sv_pure 0 failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      try {
        status = parseStatusBody(await query(buildGetstatusPacket()));
      } catch {
        // keep the pre-change status; the parse run will say if the server is gone
      }
    }
    const parseRun =
      status.sv_pure === '0' && status.sv_punkbuster === '0'
        ? await probe('pure-0', true)
        : null;
    process.stdout.write(
      `${JSON.stringify(summarize(status, pureRun, parseRun), null, 2)}\n`,
    );
  } finally {
    if (!lowered) return;
    try {
      await query(buildOobPacket(`rcon ${password} sv_pure 1`));
    } catch (error) {
      process.stderr.write(
        `rcon sv_pure 1 failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

/** Importing this file must not open a socket. Only a direct run talks to the server. */
function startedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedAsScript()) {
  await main();
}
