import { ReportAntiSpam, type SessionLookup } from '@cod2admin/report-pipeline';
import type { GatewayDeps } from '../deps.js';
import { ReportRegistry } from '../reports.js';
import { UpdateRegistry } from '../update-registry.js';
import { asRconClient, createFakeRcon, type FakeRcon } from './fake-rcon.js';
import { createFakeAdminStore, type FakeAdminStore } from './fake-admin-store.js';
import { createFakeBanStore, type FakeBanStore } from './fake-ban-store.js';
import { createFakeGithubReleaseClient, type FakeGithubReleaseClient } from './fake-github-release-client.js';

export interface FakeDeps {
  adminStore: FakeAdminStore;
  banStore: FakeBanStore;
  rcon: FakeRcon;
  githubReleaseClient: FakeGithubReleaseClient;
  deps: GatewayDeps;
}

/**
 * One connected server, alias "default", backed by a fake rcon/admin-store/ban-store. Self-update
 * (docs/PLAN.md §13.2/§13.3) defaults to *enabled* with dummy paths, since most tests don't care
 * either way — a test specifically covering the "feature disabled" branch overrides
 * `deps.updateConfig` to `undefined` directly.
 */
export function createFakeDeps(): FakeDeps {
  const adminStore = createFakeAdminStore();
  const banStore = createFakeBanStore();
  const rcon = createFakeRcon();
  const githubReleaseClient = createFakeGithubReleaseClient();
  return {
    adminStore,
    banStore,
    rcon,
    githubReleaseClient,
    deps: {
      adminStore,
      banStore,
      rconClients: new Map([['default', asRconClient(rcon)]]),
      reportRegistry: new ReportRegistry(),
      reportAntiSpam: new ReportAntiSpam<string>(),
      sessionsByServer: new Map<string, SessionLookup>(),
      updateConfig: { stagingDir: '/opt/cod2admin/staging', applyUpdateScriptPath: '/opt/cod2admin/bin/apply-update.sh' },
      githubReleaseClient,
      updateRegistry: new UpdateRegistry(),
    },
  };
}
