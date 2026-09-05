/**
 * Case-insensitive name match used to resolve a `!report` target (docs/PLAN.md §5 step 2):
 * an exact match wins outright over any partial one; otherwise falls back to substring
 * containment, so a partial name still resolves. Names are matched as given — `status()`
 * already strips color codes (`rcon-client`'s `status-parser.ts`), and `log-tailer` session
 * names are plain chat names — so no color-code handling belongs here.
 */
export function matchPlayersByName<T>(
  target: string,
  candidates: readonly T[],
  getName: (candidate: T) => string,
): T[] {
  const needle = target.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const named = candidates.filter((candidate) => getName(candidate).length > 0);

  const exact = named.filter((candidate) => getName(candidate).toLowerCase() === needle);
  if (exact.length > 0) {
    return exact;
  }

  return named.filter((candidate) => getName(candidate).toLowerCase().includes(needle));
}
