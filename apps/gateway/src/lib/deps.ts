import type { AdminStore } from '@cod2admin/admin-store';
import type { BanStore } from '@cod2admin/ban-store';
import type { RconClient } from '@cod2admin/rcon-client';
import type { ReportAntiSpam, SessionLookup } from '@cod2admin/report-pipeline';
import type { ReportRegistry } from './reports.js';

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
}
