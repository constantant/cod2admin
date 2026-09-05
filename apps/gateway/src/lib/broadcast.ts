import type { RconClient } from '@cod2admin/rcon-client';
import { sanitizeRconArg } from './sanitize.js';

/**
 * Every kick/ban/tempban broadcasts an in-game `rcon say` announcement — not silent, not
 * optional per-action (docs/PLAN.md §5 step 6, §6). Temp-ban doesn't exist until Phase 2, so
 * only kick/ban call this in Phase 1.
 */
export async function broadcastModerationAction(
  rcon: RconClient,
  target: string,
  action: string,
): Promise<void> {
  const safeTarget = sanitizeRconArg(target);
  await rcon.say(`${safeTarget} was ${action} by an admin`);
}
