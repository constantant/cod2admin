/** Regional-indicator flag for an ISO country code (`RU` → 🇷🇺); `LAN` and unknowns get none. */
export function flagEmoji(code: string | undefined): string {
  if (!code || !/^[A-Z]{2}$/.test(code)) {
    return '';
  }
  return String.fromCodePoint(
    ...[...code].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65),
  );
}

/** `45m`, `2h 30m`, `3d 4h` — the two largest units. */
export function formatSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${rest}m`;
}

/** `5m ago`, `just now`, or the date for anything older than a week. */
export function formatAgo(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 60_000) {
    return 'just now';
  }
  if (ms > 7 * 86_400_000) {
    return new Date(iso).toLocaleDateString();
  }
  return `${formatSpan(ms)} ago`;
}

/** `14:05` in the viewer's time zone. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

export interface DurationChoice {
  label: string;
  minutes: number;
}

/** The temp-ban lengths offered as one-tap chips. */
export const DURATION_CHOICES: readonly DurationChoice[] = [
  { label: '30m', minutes: 30 },
  { label: '2h', minutes: 120 },
  { label: '1d', minutes: 1440 },
  { label: '7d', minutes: 10_080 },
  { label: '30d', minutes: 43_200 },
];
