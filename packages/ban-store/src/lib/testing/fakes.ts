import type { RconClient, ServerStatus } from '@cod2admin/rcon-client';
import { vi, type Mock } from 'vitest';
import type { Ban, BanIp, BanStore } from '../types.js';

/** Test-only stand-in for `RconClient` — see the equivalent helper in `apps/gateway`. */
export interface FakeRcon {
  status: Mock<() => Promise<ServerStatus>>;
  kick: Mock<(clientIdOrName: string | number) => Promise<string>>;
  unbanUser: Mock<(guid: string) => Promise<string>>;
}

export function createFakeRcon(): FakeRcon {
  return {
    status: vi.fn().mockResolvedValue({ raw: '', players: [] } satisfies ServerStatus),
    kick: vi.fn().mockResolvedValue(''),
    unbanUser: vi.fn().mockResolvedValue(''),
  };
}

export function asRconClient(fake: FakeRcon): RconClient {
  return fake as unknown as RconClient;
}

export interface FakeBanStore {
  recordBan: Mock<BanStore['recordBan']>;
  recordIpBan: Mock<BanStore['recordIpBan']>;
  listActiveIpBans: Mock<BanStore['listActiveIpBans']>;
  listExpiredIpBans: Mock<BanStore['listExpiredIpBans']>;
  expireIpBan: Mock<BanStore['expireIpBan']>;
  listExpiredBans: Mock<BanStore['listExpiredBans']>;
  expireBan: Mock<BanStore['expireBan']>;
  listBansByGuid: Mock<BanStore['listBansByGuid']>;
  listBansByName: Mock<BanStore['listBansByName']>;
  listIpBansByIp: Mock<BanStore['listIpBansByIp']>;
  close: Mock<BanStore['close']>;
}

export function createFakeBanStore(
  overrides: Partial<{ active: BanIp[]; expired: BanIp[]; expiredBans: Ban[] }> = {},
): FakeBanStore {
  return {
    recordBan: vi.fn().mockResolvedValue(undefined),
    recordIpBan: vi.fn().mockResolvedValue(undefined),
    listActiveIpBans: vi.fn().mockResolvedValue(overrides.active ?? []),
    listExpiredIpBans: vi.fn().mockResolvedValue(overrides.expired ?? []),
    expireIpBan: vi.fn().mockResolvedValue(undefined),
    listExpiredBans: vi.fn().mockResolvedValue(overrides.expiredBans ?? []),
    expireBan: vi.fn().mockResolvedValue(undefined),
    listBansByGuid: vi.fn().mockResolvedValue([]),
    listBansByName: vi.fn().mockResolvedValue([]),
    listIpBansByIp: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

export function asBanStore(fake: FakeBanStore): BanStore {
  return fake as unknown as BanStore;
}
