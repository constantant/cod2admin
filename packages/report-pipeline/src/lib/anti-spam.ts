const DEFAULT_COOLDOWN_MS = 60_000;

export interface AntiSpamOptions {
  /** Per-reporter cooldown between *new* (non-duplicate) reports, ms. Default 60s (docs/PLAN.md §5 step 4). */
  cooldownMs?: number;
  /** How long an untouched open report keeps collapsing further reports into it. Default = `cooldownMs`. */
  dedupWindowMs?: number;
  /** Injectable clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export type AntiSpamCheck<TCardRef> =
  | { allowed: true; reason: 'fresh' }
  | { allowed: true; reason: 'duplicate'; existing: TCardRef }
  | { allowed: false; reason: 'cooldown'; retryAfterMs: number };

/**
 * Per-reporter cooldown + same-reporter/target duplicate-suppression (docs/PLAN.md §5 step 4).
 *
 * Keyed on the raw `targetName` string from the `!report` trigger, not a resolved player
 * identity — dedup needs to work the same way whether the target resolved, was ambiguous, or
 * wasn't found (an admin still cares about "reports against Cheatr123" as one thread regardless),
 * and keying this way lets `check()` run right after trigger detection (§5 step 1), before the
 * rcon/DB round-trips of resolve/enrich (steps 2-3) — the plan lists anti-spam as step 4, but
 * nothing requires waiting until then, and skipping resolution entirely for a rate-limited
 * report saves that round trip.
 *
 * Pure in-memory state — no DB. Same restart caveat as log-tailer's `SessionTracker`: a gateway
 * restart clears all cooldowns/open-report tracking, so a flood right after restart isn't
 * caught for one window. Not persisted on purpose: this is a short-lived UX/flood-control
 * concern, not the durable per-player report history that would eventually live in a `reports`
 * table (§7, not yet built) — conflating the two would tie this to that table's write path for
 * no benefit here.
 */
export class ReportAntiSpam<TCardRef> {
  private readonly lastReportAt = new Map<number, number>();
  private readonly openReports = new Map<string, { cardRef: TCardRef; at: number }>();
  private readonly cooldownMs: number;
  private readonly dedupWindowMs: number;
  private readonly now: () => number;

  constructor(options: AntiSpamOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.dedupWindowMs = options.dedupWindowMs ?? this.cooldownMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Call before acting on a `!report`. A `duplicate` result is still `allowed: true` — it means
   * "update `existing` instead of sending a new card," not "drop this" — collapsing repeats is
   * the anti-flood mechanism for the same ongoing complaint, so it's never blocked by cooldown;
   * only a genuinely new report (a new target, or the same one after its window lapsed) can be.
   */
  check(reporterNum: number, targetName: string): AntiSpamCheck<TCardRef> {
    const now = this.now();
    const open = this.openReports.get(dedupKey(reporterNum, targetName));
    if (open && now - open.at < this.dedupWindowMs) {
      return { allowed: true, reason: 'duplicate', existing: open.cardRef };
    }

    const lastAt = this.lastReportAt.get(reporterNum);
    if (lastAt !== undefined && now - lastAt < this.cooldownMs) {
      return { allowed: false, reason: 'cooldown', retryAfterMs: this.cooldownMs - (now - lastAt) };
    }

    return { allowed: true, reason: 'fresh' };
  }

  /**
   * Call once a `check()` result was actually acted on — a fresh card was posted, or an
   * existing one was updated — with a reference the next `check()` can hand back as `existing`.
   * Also resets this reporter's cooldown clock and slides the dedup window forward, so a card
   * that keeps getting re-reported stays open rather than going stale mid-flood.
   */
  track(reporterNum: number, targetName: string, cardRef: TCardRef): void {
    const now = this.now();
    this.lastReportAt.set(reporterNum, now);
    this.openReports.set(dedupKey(reporterNum, targetName), { cardRef, at: now });
  }

  /** Call once a card has been acted on (kicked/banned/ignored) — a later report gets a fresh card. */
  resolve(reporterNum: number, targetName: string): void {
    this.openReports.delete(dedupKey(reporterNum, targetName));
  }
}

function dedupKey(reporterNum: number, targetName: string): string {
  return `${reporterNum}:${targetName.trim().toLowerCase()}`;
}
