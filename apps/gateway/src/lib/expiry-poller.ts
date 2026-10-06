import { runBanEnforcementSweep, runBanExpirySweep } from '@cod2admin/ban-store';
import type { GatewayDeps } from './deps.js';

const DEFAULT_INTERVAL_MS = 10_000;

/**
 * Wires the gateway's non-event-driven actions (docs/PLAN.md §3/§5.7) onto one fixed interval:
 * the ban enforcement sweep (kick-on-sight by IP or GUID on every server, plus IP-ban expiry) and
 * the GUID-path ban expiry sweep (§5 step 7 job (b)). Sweep failures are logged, not thrown — one
 * bad tick shouldn't kill the poller or the process.
 *
 * A tick is skipped while the previous one is still running: a server that drops queries can make
 * a single `status` take ~10s (rcon-client's retries), and overlapping sweeps would only add load.
 */
export function startExpiryPoller(deps: GatewayDeps, intervalMs = DEFAULT_INTERVAL_MS): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void Promise.all([
      runBanEnforcementSweep(deps.banStore, deps.rconClients).catch((error: unknown) => {
        console.error('Ban enforcement sweep failed:', error);
      }),
      runBanExpirySweep(deps.banStore).catch((error: unknown) => {
        console.error('GUID ban expiry sweep failed:', error);
      }),
    ]).finally(() => {
      running = false;
    });
  }, intervalMs);
}
