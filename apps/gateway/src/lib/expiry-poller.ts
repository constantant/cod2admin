import { runBanExpirySweep, runIpBanSweep } from '@cod2admin/ban-store';
import type { GatewayDeps } from './deps.js';

const DEFAULT_INTERVAL_MS = 10_000;

/**
 * Wires the gateway's non-event-driven actions (docs/PLAN.md §3/§5.7) onto one fixed interval:
 * the IP-ban sweep (kick-on-sight + row expiry, Phase 2) and the GUID-path ban expiry sweep
 * (added for the report card's `Temp Ban` button, §5 step 7 job (b)) — two independently
 * testable functions, run together here since the plan calls for "the same fixed interval", not
 * one combined function. Sweep failures are logged, not thrown — one bad tick shouldn't kill the
 * poller or the process.
 */
export function startExpiryPoller(deps: GatewayDeps, intervalMs = DEFAULT_INTERVAL_MS): NodeJS.Timeout {
  return setInterval(() => {
    runIpBanSweep(deps.banStore, deps.rconClients).catch((error: unknown) => {
      console.error('IP ban sweep failed:', error);
    });
    runBanExpirySweep(deps.banStore, deps.rconClients).catch((error: unknown) => {
      console.error('GUID ban expiry sweep failed:', error);
    });
  }, intervalMs);
}
