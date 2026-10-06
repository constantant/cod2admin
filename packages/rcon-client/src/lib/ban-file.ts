/**
 * The name the game writes next to a GUID in `ban.txt` (`<guid> <name>\r\n`), mirroring Quake 3's
 * `Q_CleanStr`: a `^` followed by any character other than `^` is a color code and is dropped
 * along with that character, and every other character outside printable ASCII (0x20–0x7E) is
 * dropped too. `unbanUser` cleans its argument the same way before comparing, case-insensitively
 * (both confirmed live, docs/PLAN.md §2.4 "ban.txt").
 */
export function cleanBanFileName(name: string): string {
  let cleaned = '';
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '^' && i + 1 < name.length && name[i + 1] !== '^') {
      i++;
      continue;
    }
    const code = name.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      cleaned += name[i];
    }
  }
  return cleaned;
}

/**
 * Whether a GUID ban for a player with this name can go into `ban.txt` and later be taken back
 * out with `unbanUser`. An all-Cyrillic name cleans to nothing: its line can't be removed, and it
 * also stops `unbanUser` from matching any line after it. A cleaned name with leading or trailing
 * spaces never matches either, so neither is safe to write (docs/PLAN.md §2.4 "ban.txt").
 */
export function isBanFileSafeName(name: string): boolean {
  const cleaned = cleanBanFileName(name);
  return cleaned.length > 0 && cleaned === cleaned.trim();
}
