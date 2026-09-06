import type { ReportTrigger } from '@cod2admin/log-tailer';
import type { StatusPlayer } from '@cod2admin/rcon-client';
import type { EnrichedReport } from './enrichment.js';

/**
 * What a button press means — deliberately not `kick`/`tempban`/etc. bound to a specific
 * target/server here. The gateway layer (grammy, not built yet — docs/PLAN.md §5 step 6) is
 * expected to carry that context itself (e.g. a short report id it looks up server-side),
 * keeping this package framework- and Telegram-API-agnostic.
 */
export type ReportCardAction =
  | { kind: 'kick' }
  | { kind: 'tempban' }
  | { kind: 'ban' }
  | { kind: 'ignore' }
  | { kind: 'more-info' }
  | { kind: 'select'; candidateNum: number };

export interface ReportCardButton {
  label: string;
  action: ReportCardAction;
}

/** Outer array = keyboard rows, inner = buttons in that row — mirrors grammy's `InlineKeyboard.row()` without depending on grammy. */
export interface ReportCard {
  text: string;
  buttons: ReportCardButton[][];
}

/** `5s` / `3m 12s` / `1h 05m` — used for both a live session-so-far and a frozen final duration. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

function formatHeader(trigger: ReportTrigger): string {
  const reporterName = trigger.chat.name || `client ${trigger.chat.num}`;
  const reason = trigger.reason ? ` — ${trigger.reason}` : '';
  return `🚨 Report: ${reporterName} reported ${trigger.targetName}${reason}`;
}

function formatGuid(guid: string | undefined): string {
  return !guid || guid === '0' ? '0 (unavailable — see docs/PLAN.md §2.4)' : guid;
}

function formatBody(enriched: EnrichedReport): string {
  const { target, history } = enriched;
  const lines: string[] = [
    `Target: #${target.num} ${target.name || '(name unknown)'}`,
    `GUID: ${formatGuid(target.guid)}`,
  ];

  if (target.connected) {
    lines.push(`IP: ${target.ip ?? 'unknown'} · Ping: ${target.ping ?? '?'} · Score: ${target.score ?? '?'}`);
  }
  if (target.sessionDurationMs !== undefined) {
    lines.push(`Session: ${formatDuration(target.sessionDurationMs)}${target.connected ? ' so far' : ' (ended)'}`);
  }

  lines.push(`Prior actions on record: ${history.auditLog.length}`);
  const banCount = history.bans.length + history.ipBans.length;
  if (banCount > 0) {
    lines.push(`Prior bans on record: ${banCount}`);
  }

  if (target.chatHistory.length > 0) {
    const recent = target.chatHistory
      .slice(-3)
      .map((chat) => `"${chat.message}"`)
      .join(' / ');
    lines.push(`Recent chat: ${recent}`);
  }

  return lines.join('\n');
}

const IGNORE_BUTTON: ReportCardButton = { label: 'Ignore', action: { kind: 'ignore' } };

/**
 * Builds the report card for a resolved target — live (full action buttons) or disconnected
 * (§5 step 2's fallback: `Ignore` only, since kick/ban need a player who's actually connected
 * and `Ban` would need a resolvable GUID/IP, which is exactly what's now stale).
 */
export function buildReportCard(enriched: EnrichedReport, trigger: ReportTrigger): ReportCard {
  const text = [formatHeader(trigger), '', formatBody(enriched)].join('\n');

  if (!enriched.target.connected) {
    return {
      text: `${text}\n\n⚠️ Target disconnected before this could be resolved live.`,
      buttons: [[IGNORE_BUTTON]],
    };
  }

  return {
    text,
    buttons: [
      [
        { label: 'Kick', action: { kind: 'kick' } },
        { label: 'Temp Ban (30m)', action: { kind: 'tempban' } },
        { label: 'Ban', action: { kind: 'ban' } },
      ],
      [IGNORE_BUTTON, { label: 'More info ▾', action: { kind: 'more-info' } }],
    ],
  };
}

/** One `Select: <name>` button per row (§5 step 2) — names can be long, one per row reads better than packing several in. */
export function buildAmbiguousReportCard(trigger: ReportTrigger, candidates: readonly StatusPlayer[]): ReportCard {
  const text = `${formatHeader(trigger)}\n\nMultiple players match "${trigger.targetName}" — pick one:`;
  const selectRows = candidates.map((candidate) => [
    { label: `Select: ${candidate.name || `client ${candidate.num}`}`, action: { kind: 'select' as const, candidateNum: candidate.num } },
  ]);
  return { text, buttons: [...selectRows, [IGNORE_BUTTON]] };
}

/** Not explicitly specced (§5 step 2 only names resolved/ambiguous/disconnected) — a typo'd or fully-expired name still needs some card, not silence. */
export function buildNotFoundReportCard(trigger: ReportTrigger): ReportCard {
  const text = `${formatHeader(trigger)}\n\nNo player matching "${trigger.targetName}" is connected or recently seen.`;
  return { text, buttons: [[IGNORE_BUTTON]] };
}
