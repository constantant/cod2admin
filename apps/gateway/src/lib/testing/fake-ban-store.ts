import type { BanIp, BanStore } from '@cod2admin/ban-store';
import { vi, type Mock } from 'vitest';

export interface FakeBanStore extends BanStore {
  recordBan: Mock<BanStore['recordBan']>;
  recordIpBan: Mock<BanStore['recordIpBan']>;
  listActiveIpBans: Mock<BanStore['listActiveIpBans']>;
  listExpiredIpBans: Mock<BanStore['listExpiredIpBans']>;
  expireIpBan: Mock<BanStore['expireIpBan']>;
  listBansByGuid: Mock<BanStore['listBansByGuid']>;
  listBansByName: Mock<BanStore['listBansByName']>;
  listIpBansByIp: Mock<BanStore['listIpBansByIp']>;
  close: Mock<BanStore['close']>;
}

export function createFakeBanStore(overrides: Partial<{ active: BanIp[] }> = {}): FakeBanStore {
  return {
    recordBan: vi.fn().mockResolvedValue(undefined),
    recordIpBan: vi.fn().mockResolvedValue(undefined),
    listActiveIpBans: vi.fn().mockResolvedValue(overrides.active ?? []),
    listExpiredIpBans: vi.fn().mockResolvedValue([]),
    expireIpBan: vi.fn().mockResolvedValue(undefined),
    listBansByGuid: vi.fn().mockResolvedValue([]),
    listBansByName: vi.fn().mockResolvedValue([]),
    listIpBansByIp: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
