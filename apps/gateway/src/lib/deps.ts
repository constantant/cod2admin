import type { AdminStore } from '@cod2admin/admin-store';
import type { BanStore } from '@cod2admin/ban-store';
import type { RconClient } from '@cod2admin/rcon-client';
import type { ReportAntiSpam, SessionLookup } from '@cod2admin/report-pipeline';
import type { GithubReleaseClient } from './github-releases.js';
import type { ReportRegistry } from './reports.js';
import type { UpdateRegistry } from './update-registry.js';

/**
 * Self-update (docs/PLAN.md §13.2/§13.3) config, derived from `GatewayConfig.updateStagingDir` in
 * main.ts. `undefined` means the feature is disabled — either running outside a real install
 * (e.g. `nx serve`) or an install that hasn't re-run `install.sh` since this shipped
 * (`UPDATE_STAGING_DIR` wasn't in `.env` yet). `applyUpdateScriptPath` is derived rather than a
 * second env var: `bin/` and `staging/` are always siblings under `$INSTALL_DIR` per §13.5's
 * layout.
 */
export interface UpdateFeatureConfig {
  stagingDir: string;
  applyUpdateScriptPath: string;
}

/** Everything a command handler needs beyond the incoming update (docs/PLAN.md §9 Phase 2). */
export interface GatewayDeps {
  adminStore: AdminStore;
  banStore: BanStore;
  rconClients: Map<string, RconClient>;
  /**
   * Report-card state (docs/PLAN.md §5 steps 4/6) — process-lifetime, shared between `bot.ts`'s
   * callback handler and `main.ts`'s `GameLogTailer` wiring (`report-tailers.ts`), so both sides
   * see the same in-flight reports/cooldowns.
   */
  reportRegistry: ReportRegistry;
  reportAntiSpam: ReportAntiSpam<string>;
  /** Per-server session lookup (a `GameLogTailer` instance) for the `select` button's re-enrichment — keyed like `rconClients`. */
  sessionsByServer: Map<string, SessionLookup>;
  updateConfig: UpdateFeatureConfig | undefined;
  githubReleaseClient: GithubReleaseClient;
  /** Pending `/update` confirm/cancel cards (docs/PLAN.md §13.3) — same shape/lifetime caveats as `reportRegistry`. */
  updateRegistry: UpdateRegistry;
  /** Set by the version-check poller so it notifies the owner once per new tag, not every tick. */
  lastNotifiedTag?: string;
}
