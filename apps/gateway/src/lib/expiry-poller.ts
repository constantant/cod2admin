import {
  runBanEnforcementSweep,
  runBanExpirySweep,
} from '@cod2admin/ban-store';
import type { RconClient } from '@cod2admin/rcon-client';
import type { GatewayDeps } from './deps.js';
import { reportRconError } from './map-change-timeouts.js';

const DEFAULT_INTERVAL_MS = 10_000;

type SweepDeps = Pick<
  GatewayDeps,
  | 'banStore'
  | 'rconClients'
  | 'adminStore'
  | 'chatTemplates'
  | 'vpn'
  | 'knownPlayers'
  | 'vpnKick'
  | 'mapChangeTimeouts'
>;

/**
 * The same clients, except that `status()` is asked of the server at most once per client for
 * the life of the returned map. Every caller gets the same promise, a failure included, so a
 * server that doesn't answer costs one round of retries, not one per sweep. Nothing is fetched
 * until a sweep calls `status()`, so a sweep that is off still costs nothing. Other methods
 * (`kick`, `say`, ...) go straight to the real client. `onStatus` sees each status that arrives.
 */
export function shareStatusPerRound(
  clients: Map<string, RconClient>,
  onStatus?: (
    alias: string,
    status: Awaited<ReturnType<RconClient['status']>>,
  ) => void,
): Map<string, RconClient> {
  const shared = new Map<string, RconClient>();
  for (const [alias, client] of clients) {
    let pending: ReturnType<RconClient['status']> | undefined;
    const status = () =>
      (pending ??= client.status().then((result) => {
        onStatus?.(alias, result);
        return result;
      }));
    shared.set(
      alias,
      new Proxy(client, {
        get(target, prop) {
          if (prop === 'status') {
            return status;
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    );
  }
  return shared;
}

/**
 * One poller round: the ban enforcement sweep, the GUID ban expiry sweep, and the `/known` and
 * `/vpnkick` sweeps, all reading one shared `rcon status` per server (see
 * {@link shareStatusPerRound}). Before, each sweep sent its own `status`, up to three per server
 * every 10s. Sweep failures are logged, not thrown, and a timeout from a map load is not logged
 * at all (map-change-timeouts.ts).
 */
export async function runSweepRound(deps: SweepDeps): Promise<void> {
  const timeouts = deps.mapChangeTimeouts;
  const rconClients = shareStatusPerRound(deps.rconClients, (alias, status) =>
    timeouts.noteStatus(alias, status),
  );
  const round = { ...deps, rconClients };
  await Promise.all([
    runBanEnforcementSweep(deps.banStore, rconClients, (alias, error) => {
      reportRconError(timeouts, alias, error, () => {
        console.error(`Ban sweep failed for server "${alias}":`, error);
      });
    }).catch((error: unknown) => {
      console.error('Ban enforcement sweep failed:', error);
    }),
    runBanExpirySweep(deps.banStore).catch((error: unknown) => {
      console.error('GUID ban expiry sweep failed:', error);
    }),
    deps.knownPlayers.sweep(round).catch((error: unknown) => {
      console.error('Known players sweep failed:', error);
    }),
    deps.vpnKick.sweep(round).catch((error: unknown) => {
      console.error('VPN kick sweep failed:', error);
    }),
  ]);
}

/**
 * Wires the gateway's non-event-driven actions (docs/PLAN.md §3/§5.7) onto one fixed interval:
 * the ban enforcement sweep (kick-on-sight by IP or GUID on every server, plus IP-ban expiry) and
 * the GUID-path ban expiry sweep (§5 step 7 job (b)), and the `/vpnkick` and `/known` sweeps when they're on
 * (vpn-kick.ts, known-players.ts). See {@link runSweepRound}.
 *
 * A tick is skipped while the previous one is still running: a server that drops queries can make
 * a single `status` take ~10s (rcon-client's retries), and overlapping sweeps would only add load.
 */
export function startExpiryPoller(
  deps: GatewayDeps,
  intervalMs = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void runSweepRound(deps).finally(() => {
      running = false;
    });
  }, intervalMs);
}
