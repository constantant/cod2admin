/** Modes whose `scr_<mode>_timelimit` is a plain per-map clock (S&D and friends run per-round clocks). */
const TIMED_MODES = new Set(['ctf', 'ctfb', 'hq', 'tdm', 'dm']);

/**
 * The map's time limit in minutes, or `undefined` when there is none (`0`), the cvar isn't there,
 * or the mode isn't one with a per-map clock.
 */
export function timeLimitMinutes(
  cvars: Record<string, string>,
  gametype: string | null,
): number | undefined {
  const mode = gametype?.toLowerCase();
  if (!mode || !TIMED_MODES.has(mode)) {
    return undefined;
  }
  const key = `scr_${mode}_timelimit`;
  const raw = Object.entries(cvars).find(
    ([name]) => name.toLowerCase() === key,
  )?.[1];
  const minutes = Number.parseFloat(raw ?? '');
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
