import type { Ban, BanIp, BanStore } from '@cod2admin/ban-store';
import { vi, type Mock } from 'vitest';

export interface FakeBanStore extends BanStore {
  recordBan: Mock<BanStore['recordBan']>;
  recordIpBan: Mock<BanStore['recordIpBan']>;
  listActiveIpBans: Mock<BanStore['listActiveIpBans']>;
  listExpiredIpBans: Mock<BanStore['listExpiredIpBans']>;
  expireIpBan: Mock<BanStore['expireIpBan']>;
  unbanIp: Mock<BanStore['unbanIp']>;
  listExpiredBans: Mock<BanStore['listExpiredBans']>;
  expireBan: Mock<BanStore['expireBan']>;
  listActiveBans: Mock<BanStore['listActiveBans']>;
  unbanByGuid: Mock<BanStore['unbanByGuid']>;
  listBansByGuid: Mock<BanStore['listBansByGuid']>;
  listBansByName: Mock<BanStore['listBansByName']>;
  listIpBansByIp: Mock<BanStore['listIpBansByIp']>;
  searchBans: Mock<BanStore['searchBans']>;
  searchIpBans: Mock<BanStore['searchIpBans']>;
  getBan: Mock<BanStore['getBan']>;
  getIpBan: Mock<BanStore['getIpBan']>;
  updateBan: Mock<BanStore['updateBan']>;
  updateIpBan: Mock<BanStore['updateIpBan']>;
  close: Mock<BanStore['close']>;
}

export function createFakeBanStore(
  overrides: Partial<{
    active: BanIp[];
    expiredBans: Ban[];
    activeBans: Ban[];
  }> = {},
): FakeBanStore {
  return {
    recordBan: vi.fn().mockResolvedValue(undefined),
    recordIpBan: vi.fn().mockResolvedValue(undefined),
    listActiveIpBans: vi.fn().mockResolvedValue(overrides.active ?? []),
    listExpiredIpBans: vi.fn().mockResolvedValue([]),
    expireIpBan: vi.fn().mockResolvedValue(undefined),
    unbanIp: vi.fn().mockResolvedValue(1),
    listExpiredBans: vi.fn().mockResolvedValue(overrides.expiredBans ?? []),
    expireBan: vi.fn().mockResolvedValue(undefined),
    listActiveBans: vi.fn().mockResolvedValue(overrides.activeBans ?? []),
    unbanByGuid: vi.fn().mockResolvedValue([]),
    listBansByGuid: vi.fn().mockResolvedValue([]),
    listBansByName: vi.fn().mockResolvedValue([]),
    listIpBansByIp: vi.fn().mockResolvedValue([]),
    searchBans: vi.fn().mockResolvedValue([]),
    searchIpBans: vi.fn().mockResolvedValue([]),
    getBan: vi.fn().mockResolvedValue(undefined),
    getIpBan: vi.fn().mockResolvedValue(undefined),
    updateBan: vi.fn().mockResolvedValue(undefined),
    updateIpBan: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

export function sampleGuidBan(overrides: Partial<Ban> = {}): Ban {
  return {
    id: 1,
    serverAlias: 'default',
    guid: 'GUID123',
    name: 'Cheater',
    reason: null,
    bannedBy: 1,
    bannedAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: null,
    unbannedAt: null,
    ...overrides,
  };
}
