import type { AuditLogEntry } from '@cod2admin/admin-store';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { markdownTable, replyWithReport, reportDocument, reportFileName, type LongReply } from '../long-reply.js';
import { formatTelegramUser } from '../telegram-user.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** How many entries the short `/auditlog` shows before pointing at the attached file. */
const SUMMARY_ENTRIES = 5;

function formatEntry(entry: AuditLogEntry): string {
  const target = entry.target ? ` → ${entry.target}` : '';
  const reason = entry.reason ? ` (${entry.reason})` : '';
  const actor = formatTelegramUser(entry.actorTelegramId, entry.actorUsername, entry.actorFirstName);
  return `${entry.createdAt.toISOString()} · ${actor} · ${entry.action}${target}${reason}`;
}

export function formatAuditLogMessage(entries: AuditLogEntry[]): string {
  if (entries.length === 0) {
    return 'No audit log entries.';
  }
  return entries.map(formatEntry).join('\n');
}

/** The short `/auditlog` for a long list: the newest few entries. */
export function formatAuditLogSummary(entries: AuditLogEntry[]): string {
  return [
    `Audit log — last ${entries.length} entries, newest ${Math.min(SUMMARY_ENTRIES, entries.length)} shown:`,
    '',
    ...entries.slice(0, SUMMARY_ENTRIES).map(formatEntry),
    '',
    'All of them in the attached file.',
  ].join('\n');
}

/** The attached `/auditlog` report: one table row per entry. */
export function formatAuditLogReport(entries: AuditLogEntry[], now: Date): string {
  const rows = entries.map((entry) => [
    entry.createdAt.toISOString().slice(0, 19).replace('T', ' '),
    formatTelegramUser(entry.actorTelegramId, entry.actorUsername, entry.actorFirstName),
    entry.action,
    entry.target,
    entry.serverAlias,
    entry.reason,
    entry.source,
  ]);
  return reportDocument({
    title: 'Audit log',
    meta: [`Entries: ${entries.length} (newest first)`],
    body: markdownTable(['Time (UTC)', 'Who', 'Action', 'Target', 'Server', 'Reason', 'Source'], rows),
    now,
  });
}

export function buildAuditLogReply(entries: AuditLogEntry[], now: Date = new Date()): LongReply {
  return {
    full: formatAuditLogMessage(entries),
    summary: formatAuditLogSummary(entries),
    markdown: formatAuditLogReport(entries, now),
    fileName: reportFileName('auditlog', undefined, now),
  };
}

/** `/auditlog [n]` — owner-only (docs/PLAN.md §4). */
export async function auditLogCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const requested = Number.parseInt(matchText(ctx), 10);
  const limit = Number.isNaN(requested) ? DEFAULT_LIMIT : Math.min(Math.max(requested, 1), MAX_LIMIT);

  const entries = await deps.adminStore.listAuditLog(limit);
  await replyWithReport(ctx, buildAuditLogReply(entries));
}
