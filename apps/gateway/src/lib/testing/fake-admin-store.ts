import {
  ADMIN_PERMISSIONS,
  MODERATOR_PERMISSIONS,
  type Admin,
  type AdminStore,
  type KnownPlayer,
  type Permission,
  type Report,
} from '@cod2admin/admin-store';
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
  setPermissions: Mock<AdminStore['setPermissions']>;
  listAdmins: Mock<AdminStore['listAdmins']>;
  saveTelegramUser: Mock<AdminStore['saveTelegramUser']>;
  upsertServer: Mock<AdminStore['upsertServer']>;
  setServerLogPath: Mock<AdminStore['setServerLogPath']>;
  getServer: Mock<AdminStore['getServer']>;
  listServers: Mock<AdminStore['listServers']>;
  bindServerToChat: Mock<AdminStore['bindServerToChat']>;
  getServerForChat: Mock<AdminStore['getServerForChat']>;
  removeServer: Mock<AdminStore['removeServer']>;
  setDefaultServer: Mock<AdminStore['setDefaultServer']>;
  getDefaultServer: Mock<AdminStore['getDefaultServer']>;
  getSetting: Mock<AdminStore['getSetting']>;
  setSetting: Mock<AdminStore['setSetting']>;
  deleteSetting: Mock<AdminStore['deleteSetting']>;
  recordAuditLog: Mock<AdminStore['recordAuditLog']>;
  listAuditLog: Mock<AdminStore['listAuditLog']>;
  listAuditLogForTarget: Mock<AdminStore['listAuditLogForTarget']>;
  searchAuditLog: Mock<AdminStore['searchAuditLog']>;
  listAuditActions: Mock<AdminStore['listAuditActions']>;
  recordReport: Mock<AdminStore['recordReport']>;
  getReport: Mock<AdminStore['getReport']>;
  searchReports: Mock<AdminStore['searchReports']>;
  countOpenReports: Mock<AdminStore['countOpenReports']>;
  resolveReport: Mock<AdminStore['resolveReport']>;
  addPlayerNote: Mock<AdminStore['addPlayerNote']>;
  getPlayerNote: Mock<AdminStore['getPlayerNote']>;
  searchPlayerNotes: Mock<AdminStore['searchPlayerNotes']>;
  findPlayerNotes: Mock<AdminStore['findPlayerNotes']>;
  updatePlayerNote: Mock<AdminStore['updatePlayerNote']>;
  deletePlayerNote: Mock<AdminStore['deletePlayerNote']>;
  listKnownPlayers: Mock<AdminStore['listKnownPlayers']>;
  saveKnownPlayer: Mock<AdminStore['saveKnownPlayer']>;
  deleteKnownPlayer: Mock<AdminStore['deleteKnownPlayer']>;
  recordServerSnapshot: Mock<AdminStore['recordServerSnapshot']>;
  listServerSnapshots: Mock<AdminStore['listServerSnapshots']>;
  pruneServerSnapshots: Mock<AdminStore['pruneServerSnapshots']>;
  close: Mock<AdminStore['close']>;
}

export function sampleReport(overrides: Partial<Report> = {}): Report {
  const at = new Date('2026-11-03T12:00:00Z');
  return {
    id: 1,
    serverAlias: 'default',
    reporterName: 'Honest',
    reporterGuid: null,
    targetName: 'Cheater',
    reason: 'aimbot',
    status: 'open',
    count: 1,
    createdAt: at,
    lastReportedAt: at,
    resolvedBy: null,
    resolvedAt: null,
    outcome: null,
    ...overrides,
  };
}

/** Stored shape of the owner. `hasPermission` is true for every id. */
export const OWNER_ACCESS = {
  isOwner: true,
  permissions: [] as Permission[],
};

/** What the old admin role could do — a template, not a rank. */
export const ADMIN_ACCESS = {
  isOwner: false,
  permissions: [...ADMIN_PERMISSIONS] as Permission[],
};

/** What the old moderator role could do. */
export const MODERATOR_ACCESS = {
  isOwner: false,
  permissions: [...MODERATOR_PERMISSIONS] as Permission[],
};

/** Convenience for tests that just need to simulate "this actor is already an admin". Defaults to the owner. */
export function sampleAdmin(overrides: Partial<Admin> = {}): Admin {
  const { permissions, ...rest } = overrides;
  return {
    telegramId: 1,
    isOwner: true,
    addedBy: null,
    addedAt: new Date(),
    username: null,
    firstName: null,
    ...rest,
    permissions: [...(permissions ?? [])],
  };
}

export function createFakeAdminStore(
  overrides: Partial<{ admins: Admin[] }> = {},
): FakeAdminStore {
  const admins = overrides.admins ?? [];
  const known = new Map<string, KnownPlayer>();
  return {
    getAdmin: vi.fn(async (telegramId: number) =>
      admins.find((admin) => admin.telegramId === telegramId),
    ),
    claimOwner: vi.fn().mockResolvedValue('claimed'),
    addAdmin: vi.fn().mockResolvedValue(undefined),
    removeAdmin: vi.fn().mockResolvedValue(undefined),
    setPermissions: vi.fn().mockResolvedValue(undefined),
    listAdmins: vi.fn().mockResolvedValue(admins),
    saveTelegramUser: vi.fn().mockResolvedValue(undefined),
    upsertServer: vi.fn().mockResolvedValue(undefined),
    setServerLogPath: vi.fn().mockResolvedValue(undefined),
    getServer: vi.fn().mockResolvedValue(undefined),
    listServers: vi.fn().mockResolvedValue([]),
    bindServerToChat: vi.fn().mockResolvedValue(undefined),
    getServerForChat: vi.fn().mockResolvedValue(undefined),
    removeServer: vi.fn().mockResolvedValue(true),
    setDefaultServer: vi.fn().mockResolvedValue(true),
    getDefaultServer: vi.fn().mockResolvedValue(undefined),
    getSetting: vi.fn().mockResolvedValue(undefined),
    setSetting: vi.fn().mockResolvedValue(undefined),
    deleteSetting: vi.fn().mockResolvedValue(undefined),
    recordAuditLog: vi.fn().mockResolvedValue(undefined),
    listAuditLog: vi.fn().mockResolvedValue([]),
    listAuditLogForTarget: vi.fn().mockResolvedValue([]),
    searchAuditLog: vi.fn().mockResolvedValue([]),
    listAuditActions: vi.fn().mockResolvedValue([]),
    recordReport: vi.fn(async () => sampleReport()),
    getReport: vi.fn().mockResolvedValue(undefined),
    searchReports: vi.fn().mockResolvedValue([]),
    countOpenReports: vi.fn().mockResolvedValue(0),
    resolveReport: vi.fn().mockResolvedValue(undefined),
    addPlayerNote: vi.fn(),
    getPlayerNote: vi.fn().mockResolvedValue(undefined),
    searchPlayerNotes: vi.fn().mockResolvedValue([]),
    findPlayerNotes: vi.fn().mockResolvedValue([]),
    updatePlayerNote: vi.fn().mockResolvedValue(undefined),
    deletePlayerNote: vi.fn().mockResolvedValue(false),
    // Stateful, so a save is visible to the next list — like the real table.
    listKnownPlayers: vi.fn(async () => [...known.values()]),
    saveKnownPlayer: vi.fn(async (input) => {
      const row: KnownPlayer = {
        note: null,
        ...input,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      known.set(input.name, row);
      return row;
    }),
    deleteKnownPlayer: vi.fn(async (name: string) => known.delete(name)),
    recordServerSnapshot: vi.fn().mockResolvedValue(undefined),
    listServerSnapshots: vi.fn().mockResolvedValue([]),
    pruneServerSnapshots: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
