import type { AdminStore } from '@cod2admin/admin-store';
import type { BanStore } from '@cod2admin/ban-store';
import type { RconClient } from '@cod2admin/rcon-client';

/** Everything a command handler needs beyond the incoming update (docs/PLAN.md §9 Phase 2). */
export interface GatewayDeps {
  adminStore: AdminStore;
  banStore: BanStore;
  rconClients: Map<string, RconClient>;
}
