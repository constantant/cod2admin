import type { ServerSnapshot } from '@cod2admin/admin-store';
import type { DashboardHistory } from './api-types.js';

/** A phone-wide chart has no use for more points than this. */
const MAX_POINTS = 120;
const TOP_MAPS = 5;

/**
 * Turns a period's snapshots (oldest first) into what the dashboard shows. A point is the *most*
 * players seen in its slice of time, so a short busy spell doesn't average away; `null` means the
 * server never answered in that slice, which draws as a gap rather than as zero players.
 */
export function summarizeSnapshots(
  snapshots: readonly ServerSnapshot[],
  since: Date,
  until: Date,
): DashboardHistory {
  const answered = snapshots.filter((snapshot) => snapshot.online);
  const span = Math.max(1, until.getTime() - since.getTime());
  const sliceMs = span / MAX_POINTS;
  const slices = new Map<number, number | null>();
  for (const snapshot of snapshots) {
    const slice = Math.min(
      MAX_POINTS - 1,
      Math.max(
        0,
        Math.floor((snapshot.at.getTime() - since.getTime()) / sliceMs),
      ),
    );
    const seen = slices.get(slice) ?? null;
    slices.set(
      slice,
      snapshot.online ? Math.max(seen ?? 0, snapshot.playerCount) : seen,
    );
  }
  const points = [...slices.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slice, players]) => ({
      at: new Date(since.getTime() + (slice + 0.5) * sliceMs).toISOString(),
      players,
    }));

  let peak: DashboardHistory['peak'] = null;
  let total = 0;
  const mapCounts = new Map<string, number>();
  for (const snapshot of answered) {
    total += snapshot.playerCount;
    if (!peak || snapshot.playerCount > peak.players) {
      peak = { players: snapshot.playerCount, at: snapshot.at.toISOString() };
    }
    // What was played: an empty server sitting on a map says nothing about it.
    if (snapshot.map && snapshot.playerCount > 0) {
      mapCounts.set(snapshot.map, (mapCounts.get(snapshot.map) ?? 0) + 1);
    }
  }
  const played = [...mapCounts.values()].reduce((sum, value) => sum + value, 0);
  return {
    samples: snapshots.length,
    points,
    peak,
    average: answered.length > 0 ? total / answered.length : null,
    uptimePercent:
      snapshots.length > 0 ? (answered.length / snapshots.length) * 100 : null,
    topMaps: [...mapCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, TOP_MAPS)
      .map(([map, count]) => ({ map, percent: (count / played) * 100 })),
  };
}
