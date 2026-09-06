import type { AdminStore, AuditLogEntry } from '@cod2admin/admin-store';
import type { Ban, BanIp, BanStore } from '@cod2admin/ban-store';
import { sessionDurationMs, type ChatEvent, type PlayerSession, type ReportTrigger } from '@cod2admin/log-tailer';
import type { ResolvedTarget } from './target-resolver.js';

const DEFAULT_HISTORY_LIMIT = 10;

/** The slice of `GameLogTailer`/`SessionTracker` enrichment needs beyond target resolution. */
export interface SessionLookup {
  getSession(num: number): PlayerSession | undefined;
}

export interface EnrichReportDeps {
  sessions: SessionLookup;
  adminStore: Pick<AdminStore, 'listAuditLogForTarget'>;
  banStore: Pick<BanStore, 'listBansByGuid' | 'listBansByName' | 'listIpBansByIp'>;
  serverAlias: string;
  /** Max rows per history query (docs/PLAN.md §5 step 3). Default 10. */
  historyLimit?: number;
}

export interface EnrichedTarget {
  num: number;
  name: string;
  guid?: string;
  /** Only known for a still-connected target — `status()` is the sole source of IP (§5.3). */
  ip?: string;
  ping?: number;
  score?: number;
  connected: boolean;
  /** Undefined only if log-tailer never saw this player's `connect` line (e.g. gateway restart mid-session). */
  sessionDurationMs?: number;
  chatHistory: ChatEvent[];
}

export interface EnrichedReporter {
  num: number;
  name: string;
  guid: string;
}

export interface ReportHistory {
  auditLog: AuditLogEntry[];
  bans: Ban[];
  ipBans: BanIp[];
}

export interface EnrichedReport {
  target: EnrichedTarget;
  reporter: EnrichedReporter;
  history: ReportHistory;
}

/** `'0'`/absent means "no valid GUID" (docs/PLAN.md §2.4) — not a usable correlation key. */
function isUsableGuid(guid: string | undefined): guid is string {
  return guid !== undefined && guid !== '0';
}

function enrichTarget(resolution: ResolvedTarget, sessions: SessionLookup): EnrichedTarget {
  if (resolution.kind === 'resolved') {
    const { player } = resolution;
    const session = sessions.getSession(player.num);
    return {
      num: player.num,
      name: player.name,
      guid: player.guid,
      ip: player.ip,
      ping: player.ping,
      score: player.score,
      connected: true,
      sessionDurationMs: session ? sessionDurationMs(session) : undefined,
      chatHistory: session?.chatHistory ?? [],
    };
  }

  const session = resolution.lastKnown;
  return {
    num: session.num,
    name: session.name,
    guid: session.guid,
    connected: false,
    sessionDurationMs: sessionDurationMs(session),
    chatHistory: session.chatHistory,
  };
}

/**
 * Gathers everything docs/PLAN.md §5 step 3 lists for a resolved report target, with no rcon
 * round-trips of its own — live fields (IP/ping/score) come from `resolveReportTarget`'s
 * already-fetched `status()` result, session duration/chat history from log-tailer's in-memory
 * state, reporter info straight off the trigger's own chat line.
 *
 * "Previous reports against this identity" (§5 step 3's third bullet) is deliberately not
 * included — no `reports` table/store exists yet (§7 sketches one, but nothing writes to it
 * until the card-delivery/persistence step of this pipeline is built); only prior audit-log
 * actions (kick/ban/tempban/etc.) and ban history are available today.
 */
export async function enrichReport(
  resolution: ResolvedTarget,
  trigger: ReportTrigger,
  deps: EnrichReportDeps,
): Promise<EnrichedReport> {
  const target = enrichTarget(resolution, deps.sessions);
  const limit = deps.historyLimit ?? DEFAULT_HISTORY_LIMIT;

  // GUID unless it's the common `0` case (§2.4), where every GUID-0 player would otherwise
  // collide into one "identity" — fall back to name, same rule `resolveReportTarget` uses.
  const [auditLog, bans, ipBans] = await Promise.all([
    deps.adminStore.listAuditLogForTarget(deps.serverAlias, target.name, limit),
    isUsableGuid(target.guid)
      ? deps.banStore.listBansByGuid(deps.serverAlias, target.guid, limit)
      : deps.banStore.listBansByName(deps.serverAlias, target.name, limit),
    target.ip ? deps.banStore.listIpBansByIp(deps.serverAlias, target.ip, limit) : Promise.resolve([]),
  ]);

  return {
    target,
    reporter: { num: trigger.chat.num, name: trigger.chat.name, guid: trigger.chat.guid },
    history: { auditLog, bans, ipBans },
  };
}
