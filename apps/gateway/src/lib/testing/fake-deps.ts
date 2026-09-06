import { ReportAntiSpam, type SessionLookup } from '@cod2admin/report-pipeline';
import type { GatewayDeps } from '../deps.js';
import { ReportRegistry } from '../reports.js';
import { asRconClient, createFakeRcon, type FakeRcon } from './fake-rcon.js';
import { createFakeAdminStore, type FakeAdminStore } from './fake-admin-store.js';
import { createFakeBanStore, type FakeBanStore } from './fake-ban-store.js';

export interface FakeDeps {
  adminStore: FakeAdminStore;
  banStore: FakeBanStore;
  rcon: FakeRcon;
  deps: GatewayDeps;
}

/** One connected server, alias "default", backed by a fake rcon/admin-store/ban-store. */
export function createFakeDeps(): FakeDeps {
  const adminStore = createFakeAdminStore();
  const banStore = createFakeBanStore();
  const rcon = createFakeRcon();
  return {
    adminStore,
    banStore,
    rcon,
    deps: {
      adminStore,
      banStore,
      rconClients: new Map([['default', asRconClient(rcon)]]),
      reportRegistry: new ReportRegistry(),
      reportAntiSpam: new ReportAntiSpam<string>(),
      sessionsByServer: new Map<string, SessionLookup>(),
    },
  };
}
