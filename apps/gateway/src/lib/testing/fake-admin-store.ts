import type { Admin, AdminStore } from '@cod2admin/admin-store';
import { vi, type Mock } from 'vitest';

/**
 * Test-only stand-in for `AdminStore` — a plain TS interface (not a class), so this satisfies it
 * directly with no cast needed, unlike `RconClient` (see `fake-rcon.ts`).
 */
export interface FakeAdminStore extends AdminStore {
  getAdmin: Mock<AdminStore['getAdmin']>;
  claimOwner: Mock<AdminStore['claimOwner']>;
  addAdmin: Mock<AdminStore['addAdmin']>;
  removeAdmin: Mock<AdminStore['removeAdmin']>;
  setRole: Mock<AdminStore['setRole']>;
  listAdmins: Mock<AdminStore['listAdmins']>;
  upsertServer: Mock<AdminStore['upsertServer']>;
  getServer: Mock<AdminStore['getServer']>;
  listServers: Mock<AdminStore['listServers']>;
  bindServerToChat: Mock<AdminStore['bindServerToChat']>;
  getServerForChat: Mock<AdminStore['getServerForChat']>;
  recordAuditLog: Mock<AdminStore['recordAuditLog']>;
  listAuditLog: Mock<AdminStore['listAuditLog']>;
  listAuditLogForTarget: Mock<AdminStore['listAuditLogForTarget']>;
  close: Mock<AdminStore['close']>;
}

/** Convenience for tests that just need to simulate "this actor is already an admin". */
export function sampleAdmin(overrides: Partial<Admin> = {}): Admin {
  return { telegramId: 1, role: 'owner', addedBy: null, addedAt: new Date(), ...overrides };
}

export function createFakeAdminStore(overrides: Partial<{ admins: Admin[] }> = {}): FakeAdminStore {
  const admins = overrides.admins ?? [];
  return {
    getAdmin: vi.fn(async (telegramId: number) => admins.find((admin) => admin.telegramId === telegramId)),
    claimOwner: vi.fn().mockResolvedValue('claimed'),
    addAdmin: vi.fn().mockResolvedValue(undefined),
    removeAdmin: vi.fn().mockResolvedValue(undefined),
    setRole: vi.fn().mockResolvedValue(undefined),
    listAdmins: vi.fn().mockResolvedValue(admins),
    upsertServer: vi.fn().mockResolvedValue(undefined),
    getServer: vi.fn().mockResolvedValue(undefined),
    listServers: vi.fn().mockResolvedValue([]),
    bindServerToChat: vi.fn().mockResolvedValue(undefined),
    getServerForChat: vi.fn().mockResolvedValue(undefined),
    recordAuditLog: vi.fn().mockResolvedValue(undefined),
    listAuditLog: vi.fn().mockResolvedValue([]),
    listAuditLogForTarget: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
