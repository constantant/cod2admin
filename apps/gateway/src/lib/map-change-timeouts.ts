import { UdpQueryTimeoutError } from '@cod2admin/rcon-client';

/**
 * How long timeouts are held back before they are logged anyway. The dev server's map loads
 * froze it for up to ~40s (docs/PLAN.md §2.4, "Map change freezes"), and the last query sent
 * into a freeze can itself take ~10s of retries, so this is comfortably past both.
 */
export const MAP_CHANGE_GRACE_MS = 90_000;

interface Episode {
  startedAt: number;
  /** The map the last good status showed before the first timeout. */
  mapBefore: string | null;
  pending: (() => void)[];
  /** Past the grace period: log every timeout now, until the server answers again. */
  loud: boolean;
}

/**
 * Keeps RCON timeouts caused by a map change out of the log.
 *
 * A CoD2 server stops answering while it loads a map, for seconds and sometimes for longer than
 * rcon-client's ~10s of retries. A timeout is therefore held back instead of logged. When the
 * server answers again, the status decides: a different map means the timeout was the map load,
 * and it is dropped; the same map (or none known) means something else went wrong, and the held
 * lines are logged then. If the server is still silent after {@link MAP_CHANGE_GRACE_MS}, the
 * held lines are logged, and every further timeout is logged at once until it answers.
 *
 * Errors other than a timeout are never held. One instance serves every server; state is per alias.
 */
export class MapChangeTimeouts {
  private readonly lastMap = new Map<string, string | null>();
  private readonly episodes = new Map<string, Episode>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly graceMs = MAP_CHANGE_GRACE_MS,
  ) {}

  /** Feed every successful `status` here (any caller's). */
  noteStatus(alias: string, status: { mapName?: string }): void {
    const map = status.mapName?.trim() || null;
    const episode = this.episodes.get(alias);
    if (episode) {
      this.episodes.delete(alias);
      const mapChanged =
        episode.mapBefore !== null && map !== null && map !== episode.mapBefore;
      if (!episode.loud && !mapChanged) {
        for (const emit of episode.pending) {
          emit();
        }
      }
    }
    this.lastMap.set(alias, map);
  }

  /**
   * Reports a failed RCON call for `alias`. `emit` writes the log line the caller would have
   * written; it runs now, later, or never (a timeout from a map load).
   */
  report(alias: string, error: unknown, emit: () => void): void {
    if (!(error instanceof UdpQueryTimeoutError)) {
      emit();
      return;
    }
    const at = this.now();
    let episode = this.episodes.get(alias);
    if (!episode) {
      episode = {
        startedAt: at,
        mapBefore: this.lastMap.get(alias) ?? null,
        pending: [],
        loud: false,
      };
      this.episodes.set(alias, episode);
    }
    if (episode.loud) {
      emit();
      return;
    }
    episode.pending.push(emit);
    if (at - episode.startedAt >= this.graceMs) {
      episode.loud = true;
      for (const held of episode.pending) {
        held();
      }
      episode.pending = [];
    }
  }

  /** Forgets a server (`/removeserver`). */
  forget(alias: string): void {
    this.lastMap.delete(alias);
    this.episodes.delete(alias);
  }
}

/** `timeouts.report(...)`, or `emit()` straight away when there's no tracker. */
export function reportRconError(
  timeouts: Pick<MapChangeTimeouts, 'report'> | undefined,
  alias: string,
  error: unknown,
  emit: () => void,
): void {
  if (timeouts) {
    timeouts.report(alias, error, emit);
  } else {
    emit();
  }
}
