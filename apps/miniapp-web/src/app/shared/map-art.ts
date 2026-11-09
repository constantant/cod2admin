/** Readable name for a map file name: `mp_toujane` → `Toujane`, `mp_ctf_blackhawk` → `Ctf Blackhawk`. */
export function prettyMapName(name: string): string {
  return name
    .replace(/^mp_/i, '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * A stable placeholder picture for a map with no screenshot: the same name always gets the same
 * gradient, so a map is recognisable at a glance even before anyone adds a real image.
 */
export function mapGradient(name: string): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const hue = hash % 360;
  const shift = 30 + (hash % 50);
  return `linear-gradient(135deg, hsl(${hue} 45% 32%), hsl(${(hue + shift) % 360} 50% 22%))`;
}

/** Where a real screenshot goes: drop `<map name>.webp` into `apps/miniapp-web/public/maps/`. */
export function mapImageUrl(name: string): string {
  return `maps/${encodeURIComponent(name)}.webp`;
}
