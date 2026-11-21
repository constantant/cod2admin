/** Modes whose `scr_<mode>_timelimit` is a plain per-map clock (S&D and friends run per-round clocks). */
const TIMED_MODES = new Set(['ctf', 'ctfb', 'hq', 'tdm', 'dm']);

/** The cvar holding the mode's per-map time limit, or `undefined` for modes without one. */
export function timeLimitCvar(gametype: string | null): string | undefined {
  const mode = gametype?.toLowerCase();
  return mode && TIMED_MODES.has(mode) ? `scr_${mode}_timelimit` : undefined;
}

/** The limit in minutes from the cvar's value; `undefined` when unset or `0` (unlimited). */
export function parseTimeLimit(value: string | null): number | undefined {
  const minutes = Number.parseFloat(value ?? '');
  return Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
}

/**
 * When each server's current map was first seen. The game doesn't report its clock, so this is
 * the estimate's start: only a map change the gateway watched counts — the first map seen after
 * the gateway starts may have been running for any time already, so it has no start.
 */
export class MapStartTracker {
  private readonly seen = new Map<
    string,
    { map: string; startedAt: number | undefined }
  >();

  /** Epoch ms the map was first seen starting, or `undefined` when unknown. */
  observe(
    alias: string,
    map: string | null,
    now = Date.now(),
  ): number | undefined {
    if (map === null) {
      return this.seen.get(alias)?.startedAt;
    }
    const known = this.seen.get(alias);
    if (!known) {
      this.seen.set(alias, { map, startedAt: undefined });
      return undefined;
    }
    if (known.map !== map) {
      this.seen.set(alias, { map, startedAt: now });
      return now;
    }
    return known.startedAt;
  }
}
