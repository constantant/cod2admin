import { stripColorCodes, type CvarMap, type RconClient } from '@cod2admin/rcon-client';
import { InlineKeyboard } from 'grammy';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';

export const STATUS_REFRESH_CALLBACK_DATA = 'status:refresh';

export const statusRefreshKeyboard = new InlineKeyboard().text('Refresh', STATUS_REFRESH_CALLBACK_DATA);

/**
 * Formats the condensed `/status` message: hostname, map, player count/max (docs/PLAN.md §6).
 * No uptime — nothing in `getstatus` reports it, and session tracking is a Phase 3
 * (`log-tailer`) concern (§5.3), not available here.
 */
export function formatStatusMessage(cvars: CvarMap, playerCount: number): string {
  const hostname = cvars['sv_hostname'] ? stripColorCodes(cvars['sv_hostname']).trim() : 'unknown';
  const map = cvars['mapname'] ?? 'unknown';
  const maxClients = cvars['sv_maxclients'] ?? '?';
  return [`Server: ${hostname}`, `Map: ${map}`, `Players: ${playerCount}/${maxClients}`].join('\n');
}

/**
 * One public `getstatus` query has everything this needs (cvars + player list) — deliberately
 * not `rcon status` + `getinfo` in parallel, which doubled the load on servers that rate-limit
 * queries (docs/PLAN.md §2.4, "Rate limiting"). `rcon status` never reported a hostname either.
 */
async function fetchStatusMessage(rcon: RconClient): Promise<string> {
  const { cvars, players } = await rcon.getStatus();
  return formatStatusMessage(cvars, players.length);
}

/** `/status [--server <alias>]` — no background timer; only fetched on command/Refresh (§6). */
export async function statusCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }
  const text = await fetchStatusMessage(server.rcon);
  await ctx.reply(text, { reply_markup: statusRefreshKeyboard });
}

export interface EditableBotContext extends BotContext {
  editMessageText(text: string, other?: unknown): Promise<unknown>;
  answerCallbackQuery(): Promise<unknown>;
}

/**
 * Re-resolves the server the same way the original command would (no per-server bound chat, the
 * button click re-resolves rather than remembering the original alias — a known Phase 2
 * limitation with more than one server, acceptable since the dev setup only has one).
 */
export async function statusRefreshCallback(ctx: EditableBotContext, deps: GatewayDeps): Promise<void> {
  const server = await resolveServer(ctx, deps, undefined);
  if (!server) {
    return;
  }
  const text = await fetchStatusMessage(server.rcon);
  try {
    await ctx.editMessageText(text, { reply_markup: statusRefreshKeyboard });
  } catch (error) {
    // Telegram rejects an edit whose content is byte-identical to the current message — the
    // status genuinely hasn't changed since the last refresh, which isn't an error worth logging.
    if (!(error instanceof Error) || !error.message.includes('message is not modified')) {
      throw error;
    }
  }
  await ctx.answerCallbackQuery();
}
