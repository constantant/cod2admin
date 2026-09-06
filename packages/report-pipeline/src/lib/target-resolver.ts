import type { PlayerSession } from '@cod2admin/log-tailer';
import type { ServerStatus, StatusPlayer } from '@cod2admin/rcon-client';
import { matchPlayersByName } from './name-matcher.js';

/** The slice of `RconClient` target resolution needs — kept narrow so tests can fake it (docs/PLAN.md §11.2). */
export interface StatusSource {
  status(): Promise<ServerStatus>;
}

/** The slice of `GameLogTailer`/`SessionTracker` target resolution needs. */
export interface SessionSource {
  listSessions(): PlayerSession[];
}

export type TargetResolution =
  | { kind: 'resolved'; player: StatusPlayer }
  | { kind: 'ambiguous'; candidates: StatusPlayer[] }
  | { kind: 'disconnected'; lastKnown: PlayerSession }
  | { kind: 'not-found' };

/** The two `TargetResolution` outcomes that actually name one player — what `enrichReport` needs. */
export type ResolvedTarget = Extract<TargetResolution, { kind: 'resolved' } | { kind: 'disconnected' }>;

/**
 * Resolves a `!report` target name against the live player list (docs/PLAN.md §5 step 2), with
 * exactly one extra rcon round trip (`status()`) — the ambiguous-match `Select:` candidates and
 * the disconnected-target fallback are both built from data already in hand, no further calls.
 */
export async function resolveReportTarget(
  targetName: string,
  deps: { rcon: StatusSource; sessions: SessionSource },
): Promise<TargetResolution> {
  const status = await deps.rcon.status();
  const liveMatches = matchPlayersByName(targetName, status.players, (player) => player.name);

  if (liveMatches.length === 1) {
    return { kind: 'resolved', player: liveMatches[0] };
  }
  if (liveMatches.length > 1) {
    return { kind: 'ambiguous', candidates: liveMatches };
  }

  // Race between the chat line and the status() round trip above (§5 step 2) — the target may
  // have disconnected in the meantime. log-tailer keeps a disconnected session's last-known info
  // instead of deleting it, specifically for this fallback (docs/PLAN.md §5 step 3).
  const sessionMatches = matchPlayersByName(targetName, deps.sessions.listSessions(), (session) => session.name);
  if (sessionMatches.length > 0) {
    // Two different slots can share a name across different points in time — prefer whichever
    // was seen most recently rather than an arbitrary one.
    const mostRecent = [...sessionMatches].sort(
      (a, b) => (b.disconnectedAt ?? b.connectedAt) - (a.disconnectedAt ?? a.connectedAt),
    )[0];
    return { kind: 'disconnected', lastKnown: mostRecent };
  }

  return { kind: 'not-found' };
}
