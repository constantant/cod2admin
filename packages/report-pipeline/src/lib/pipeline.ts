import type { AdminStore } from '@cod2admin/admin-store';
import type { BanStore } from '@cod2admin/ban-store';
import type { ReportTrigger } from '@cod2admin/log-tailer';
import type { ReportAntiSpam } from './anti-spam.js';
import { enrichReport, type SessionLookup } from './enrichment.js';
import { buildAmbiguousReportCard, buildNotFoundReportCard, buildReportCard, type ReportCard } from './report-card.js';
import { resolveReportTarget, type SessionSource, type StatusSource, type TargetResolution } from './target-resolver.js';

/**
 * Sends/updates a report card wherever it actually lives (Telegram, via `apps/gateway`'s
 * grammy-backed implementation — not built yet, §5 step 6). Kept as an injected interface so
 * this package never depends on grammy or the Telegram Bot API directly.
 */
export interface CardSender<TCardRef> {
  send(chatId: number, card: ReportCard): Promise<TCardRef>;
  update(existing: TCardRef, card: ReportCard): Promise<void>;
}

export interface ProcessReportTriggerDeps<TCardRef> {
  rcon: StatusSource;
  sessions: SessionSource & SessionLookup;
  adminStore: Pick<AdminStore, 'listAuditLogForTarget'>;
  banStore: Pick<BanStore, 'listBansByGuid' | 'listBansByName' | 'listIpBansByIp'>;
  antiSpam: ReportAntiSpam<TCardRef>;
  cardSender: CardSender<TCardRef>;
  serverAlias: string;
  /** The server's bound admin chat (docs/PLAN.md §5 step 5) — `apps/gateway` looks this up via `AdminStore.getServer`. */
  chatId: number;
  historyLimit?: number;
}

export type ProcessReportTriggerOutcome<TCardRef> =
  | { kind: 'sent'; cardRef: TCardRef }
  | { kind: 'updated'; cardRef: TCardRef }
  | { kind: 'cooldown'; retryAfterMs: number };

/**
 * The full `!report` pipeline (docs/PLAN.md §5 steps 1-5, minus button handling/step 6): checks
 * anti-spam first (§5 step 4) — before the rcon/DB round trips below, not after, so a
 * cooldown-blocked report skips them entirely — then resolves the target, enriches it if
 * resolved/disconnected, builds the appropriate card, and sends or updates it via the injected
 * `cardSender`.
 */
export async function processReportTrigger<TCardRef>(
  trigger: ReportTrigger,
  deps: ProcessReportTriggerDeps<TCardRef>,
): Promise<ProcessReportTriggerOutcome<TCardRef>> {
  const check = deps.antiSpam.check(trigger.chat.num, trigger.targetName);
  if (!check.allowed) {
    return { kind: 'cooldown', retryAfterMs: check.retryAfterMs };
  }

  const resolution = await resolveReportTarget(trigger.targetName, { rcon: deps.rcon, sessions: deps.sessions });

  const card = await buildCardFor(resolution, trigger, deps);

  if (check.reason === 'duplicate') {
    await deps.cardSender.update(check.existing, card);
    deps.antiSpam.track(trigger.chat.num, trigger.targetName, check.existing);
    return { kind: 'updated', cardRef: check.existing };
  }

  const cardRef = await deps.cardSender.send(deps.chatId, card);
  deps.antiSpam.track(trigger.chat.num, trigger.targetName, cardRef);
  return { kind: 'sent', cardRef };
}

async function buildCardFor<TCardRef>(
  resolution: TargetResolution,
  trigger: ReportTrigger,
  deps: ProcessReportTriggerDeps<TCardRef>,
): Promise<ReportCard> {
  if (resolution.kind === 'ambiguous') {
    return buildAmbiguousReportCard(trigger, resolution.candidates);
  }
  if (resolution.kind === 'not-found') {
    return buildNotFoundReportCard(trigger);
  }
  const enriched = await enrichReport(resolution, trigger, {
    sessions: deps.sessions,
    adminStore: deps.adminStore,
    banStore: deps.banStore,
    serverAlias: deps.serverAlias,
    historyLimit: deps.historyLimit,
  });
  return buildReportCard(enriched, trigger);
}
