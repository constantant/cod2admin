import type { ChatEvent, PlayerSession, SessionEvent } from './types.js';

const DEFAULT_CHAT_HISTORY_SIZE = 20;

export interface SessionTrackerOptions {
  /** Max chat lines kept per session (docs/PLAN.md §5 step 3's "ring buffer"). */
  chatHistorySize?: number;
  /** Injectable clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Pure in-memory session bookkeeping (docs/PLAN.md §5 step 3) — no file I/O, so it's testable
 * without a real log. `GameLogTailer` feeds it parsed events; report-pipeline reads
 * `getSession`/`listSessions` for enrichment and the disconnected-target fallback.
 */
export class SessionTracker {
  private readonly sessions = new Map<number, PlayerSession>();
  private readonly chatHistorySize: number;
  private readonly now: () => number;

  constructor(options: SessionTrackerOptions = {}) {
    this.chatHistorySize = options.chatHistorySize ?? DEFAULT_CHAT_HISTORY_SIZE;
    this.now = options.now ?? Date.now;
  }

  /** Applies a connect/quit event, returning the resulting session for that slot. */
  handleSessionEvent(event: SessionEvent): PlayerSession {
    if (event.kind === 'connect') {
      const session: PlayerSession = {
        num: event.num,
        guid: event.guid,
        name: event.name,
        connectedAt: this.now(),
        chatHistory: [],
      };
      this.sessions.set(event.num, session);
      return session;
    }

    const existing = this.sessions.get(event.num);
    if (existing && existing.disconnectedAt === undefined) {
      existing.disconnectedAt = this.now();
      if (event.name) {
        existing.name = event.name;
      }
      return existing;
    }

    // A quit with no matching live connect (e.g. the tailer started mid-session) — synthesize an
    // already-disconnected record so callers still get a consistent PlayerSession back.
    const synthesized: PlayerSession = {
      num: event.num,
      guid: event.guid,
      name: event.name,
      connectedAt: this.now(),
      disconnectedAt: this.now(),
      chatHistory: [],
    };
    this.sessions.set(event.num, synthesized);
    return synthesized;
  }

  /** Attaches a chat line to its slot's session, if that slot has a live (not-yet-disconnected) one. */
  handleChat(chat: ChatEvent): void {
    const session = this.sessions.get(chat.num);
    if (!session || session.disconnectedAt !== undefined) {
      return;
    }
    // Chat names can lag empty right after connect (docs/PLAN.md §2.4) — backfill once known.
    if (chat.name) {
      session.name = chat.name;
    }
    session.chatHistory.push(chat);
    if (session.chatHistory.length > this.chatHistorySize) {
      session.chatHistory.shift();
    }
  }

  getSession(num: number): PlayerSession | undefined {
    return this.sessions.get(num);
  }

  listSessions(): PlayerSession[] {
    return [...this.sessions.values()];
  }
}

/** Wall-clock session length so far (or total, if disconnected) — see `PlayerSession.connectedAt`. */
export function sessionDurationMs(session: PlayerSession, now: number = Date.now()): number {
  return (session.disconnectedAt ?? now) - session.connectedAt;
}
