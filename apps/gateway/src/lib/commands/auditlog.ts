import type { AuditLogEntry } from '@cod2admin/admin-store';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function formatEntry(entry: AuditLogEntry): string {
  const target = entry.target ? ` → ${entry.target}` : '';
  const reason = entry.reason ? ` (${entry.reason})` : '';
  return `${entry.createdAt.toISOString()} · ${entry.actorTelegramId} · ${entry.action}${target}${reason}`;
}

export function formatAuditLogMessage(entries: AuditLogEntry[]): string {
  if (entries.length === 0) {
    return 'No audit log entries.';
  }
  return entries.map(formatEntry).join('\n');
}

/** `/auditlog [n]` — owner-only (docs/PLAN.md §4). */
export async function auditLogCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const requested = Number.parseInt(matchText(ctx), 10);
  const limit = Number.isNaN(requested) ? DEFAULT_LIMIT : Math.min(Math.max(requested, 1), MAX_LIMIT);

  const entries = await deps.adminStore.listAuditLog(limit);
  await ctx.reply(formatAuditLogMessage(entries));
}
