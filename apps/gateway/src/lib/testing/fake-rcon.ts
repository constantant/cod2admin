import type { CvarMap, OobStatusPlayer, RconClient, ServerStatus } from '@cod2admin/rcon-client';
import { vi, type Mock } from 'vitest';

/**
 * Test-only stand-in for `RconClient` — a plain object can't structurally satisfy the class
 * (it has private fields), so tests use this + `asRconClient` instead of a real UDP peer for
 * command-handler unit tests (docs/PLAN.md §11.2 — no real socket needed for this layer).
 */
export interface FakeRcon {
  getInfo: Mock<() => Promise<CvarMap>>;
  getStatus: Mock<() => Promise<{ cvars: CvarMap; players: OobStatusPlayer[] }>>;
  status: Mock<() => Promise<ServerStatus>>;
  rcon: Mock<(command: string) => Promise<string>>;
  kick: Mock<(clientIdOrName: string | number) => Promise<string>>;
  banClient: Mock<(clientId: number) => Promise<string>>;
  unbanUser: Mock<(name: string) => Promise<number>>;
  say: Mock<(message: string) => Promise<string>>;
  tell: Mock<(clientId: number, message: string) => Promise<string>>;
  map: Mock<(mapName: string) => Promise<string>>;
  getMapRotation: Mock<() => Promise<string[]>>;
  getInstalledMaps: Mock<() => Promise<string[]>>;
}

export function createFakeRcon(): FakeRcon {
  return {
    getInfo: vi.fn().mockResolvedValue({}),
    getStatus: vi.fn().mockResolvedValue({ cvars: {}, players: [] }),
    status: vi.fn().mockResolvedValue({ raw: '', players: [] } satisfies ServerStatus),
    rcon: vi.fn().mockResolvedValue(''),
    kick: vi.fn().mockResolvedValue(''),
    banClient: vi.fn().mockResolvedValue(''),
    unbanUser: vi.fn().mockResolvedValue(1),
    say: vi.fn().mockResolvedValue(''),
    tell: vi.fn().mockResolvedValue(''),
    map: vi.fn().mockResolvedValue(''),
    getMapRotation: vi.fn().mockResolvedValue([]),
    getInstalledMaps: vi.fn().mockResolvedValue([]),
  };
}

export function asRconClient(fake: FakeRcon): RconClient {
  return fake as unknown as RconClient;
}
