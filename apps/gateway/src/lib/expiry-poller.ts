import { runIpBanSweep } from '@cod2admin/ban-store';
import type { GatewayDeps } from './deps.js';

const DEFAULT_INTERVAL_MS = 10_000;

/**
 * Wires the gateway's one non-event-driven action (docs/PLAN.md §3/§5.7) onto a fixed interval.
 * Sweep failures are logged, not thrown — one bad tick shouldn't kill the poller or the process.
 */
export function startExpiryPoller(deps: GatewayDeps, intervalMs = DEFAULT_INTERVAL_MS): NodeJS.Timeout {
  return setInterval(() => {
    runIpBanSweep(deps.banStore, deps.rconClients).catch((error: unknown) => {
      console.error('IP ban sweep failed:', error);
    });
  }, intervalMs);
}
