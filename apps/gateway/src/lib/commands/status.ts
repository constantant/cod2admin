import type { CvarMap, RconClient, ServerStatus } from '@cod2admin/rcon-client';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../bot-context.js';

export const STATUS_REFRESH_CALLBACK_DATA = 'status:refresh';

export const statusRefreshKeyboard = new InlineKeyboard().text('Refresh', STATUS_REFRESH_CALLBACK_DATA);

/**
 * Formats the condensed `/status` message: hostname, map, player count/max (docs/PLAN.md §6).
 * No uptime — nothing in `status`/`getinfo` reports it, and session tracking is a Phase 3
 * (`log-tailer`) concern (§5.3), not available here.
 */
export function formatStatusMessage(status: ServerStatus, cvars: CvarMap): string {
  const hostname = status.hostname ?? 'unknown';
  const map = status.mapName ?? 'unknown';
  const maxClients = cvars['sv_maxclients'] ?? '?';
  return [`Server: ${hostname}`, `Map: ${map}`, `Players: ${status.players.length}/${maxClients}`].join('\n');
}

async function fetchStatusMessage(rcon: RconClient): Promise<string> {
  const [status, cvars] = await Promise.all([rcon.status(), rcon.getInfo()]);
  return formatStatusMessage(status, cvars);
}

/** `/status` — no background timer; only ever fetched on command or Refresh-button click (§6). */
export async function statusCommand(ctx: BotContext, rcon: RconClient): Promise<void> {
  const text = await fetchStatusMessage(rcon);
  await ctx.reply(text, { reply_markup: statusRefreshKeyboard });
}

export interface EditableBotContext extends BotContext {
  editMessageText(text: string, other?: unknown): Promise<unknown>;
  answerCallbackQuery(): Promise<unknown>;
}

export async function statusRefreshCallback(ctx: EditableBotContext, rcon: RconClient): Promise<void> {
  const text = await fetchStatusMessage(rcon);
  await ctx.editMessageText(text, { reply_markup: statusRefreshKeyboard });
  await ctx.answerCallbackQuery();
}
