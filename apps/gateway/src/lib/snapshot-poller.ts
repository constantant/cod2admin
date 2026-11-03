import { UdpQueryTimeoutError } from '@cod2admin/rcon-client';
import type { GatewayDeps } from './deps.js';

export const SNAPSHOT_INTERVAL_MS = 60_000;
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** `sv_maxclients` as a number, or `null` if the server doesn't say. */
function parseMaxClients(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Saves one row per server for the dashboard's history. Uses the public `getstatus`, one query a
 * minute, so a server that rate-limits queries barely notices (docs/PLAN.md §2.4). A server that
 * doesn't answer is saved as offline — that's what the uptime figure is made of.
 */
export async function takeSnapshots(
  deps: Pick<GatewayDeps, 'rconClients' | 'adminStore'>,
): Promise<void> {
  for (const [serverAlias, rcon] of deps.rconClients) {
    try {
      const status = await rcon.getStatus().catch((error: unknown) => {
        if (error instanceof UdpQueryTimeoutError) {
          return null;
        }
        throw error;
      });
      await deps.adminStore.recordServerSnapshot({
        serverAlias,
        online: status !== null,
        playerCount: status?.players.length ?? 0,
        maxClients: parseMaxClients(status?.cvars['sv_maxclients']),
        map: status?.cvars['mapname'] ?? null,
        gametype:
          status?.cvars['g_gametype'] ?? status?.cvars['gametype'] ?? null,
      });
    } catch (error) {
      console.error(`Snapshot failed for server "${serverAlias}":`, error);
    }
  }
}

/** Runs `takeSnapshots` every minute (a tick is skipped while the last one runs), and prunes old rows. */
export function startSnapshotPoller(
  deps: Pick<GatewayDeps, 'rconClients' | 'adminStore'>,
  intervalMs = SNAPSHOT_INTERVAL_MS,
): NodeJS.Timeout {
  let running = false;
  let lastPruned = 0;
  return setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void (async () => {
      await takeSnapshots(deps);
      if (Date.now() - lastPruned >= PRUNE_INTERVAL_MS) {
        lastPruned = Date.now();
        await deps.adminStore.pruneServerSnapshots(
          new Date(Date.now() - SNAPSHOT_RETENTION_MS),
        );
      }
    })()
      .catch((error: unknown) => {
        console.error('Snapshot poller failed:', error);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}
