const MAX_RCON_ARG_LENGTH = 128;

/**
 * Strips characters that could break out of a single rcon argument or chain a second console
 * command (Q3-family servers execute `;`-separated commands from one console string) before
 * player-controlled text (names, ban reasons) is interpolated into an outgoing rcon command —
 * see docs/PLAN.md §8. `/rcon` (owner-only raw passthrough) is the sole intentional exception
 * and never goes through this function.
 */
export function sanitizeRconArg(value: string): string {
  return value
    .replace(/[\r\n\0;"]/g, '')
    .trim()
    .slice(0, MAX_RCON_ARG_LENGTH);
}
