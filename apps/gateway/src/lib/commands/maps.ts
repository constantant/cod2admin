import type { AdminRole } from '@cod2admin/admin-store';
import { InlineKeyboard } from 'grammy';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';

const MAPS_PER_ROW = 2;
const MAP_SELECT_CALLBACK = /^map:(.+):([^:]+)$/;

function encodeMapCallback(alias: string, mapName: string): string {
  return `map:${alias}:${mapName}`;
}

function decodeMapCallback(data: string): { alias: string; mapName: string } | null {
  const match = MAP_SELECT_CALLBACK.exec(data);
  return match ? { alias: match[1], mapName: match[2] } : null;
}

function buildMapKeyboard(alias: string, maps: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  maps.forEach((mapName, index) => {
    keyboard.text(mapName, encodeMapCallback(alias, mapName));
    if ((index + 1) % MAPS_PER_ROW === 0) {
      keyboard.row();
    }
  });
  return keyboard;
}

/**
 * `/maps [--server <alias>]` — lists `sv_mapRotation`'s maps as tap-to-switch buttons, so admins
 * don't have to know/type an exact map name to use `/map` (docs/PLAN.md §6).
 */
export async function mapsCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  const maps = await server.rcon.getMapRotation();
  if (maps.length === 0) {
    await ctx.reply('No maps found in sv_mapRotation.');
    return;
  }

  await ctx.reply('Tap a map to switch to it:', { reply_markup: buildMapKeyboard(server.alias, maps) });
}

/** Structural subset of grammy's callback-query `Context` (mirrors `ReportCallbackContext`'s approach). */
export interface MapsCallbackContext {
  admin?: { telegramId: number; role: AdminRole };
  callbackData: string;
  editMessageText(text: string, other?: unknown): Promise<unknown>;
  answerCallbackQuery(other?: { text?: string }): Promise<unknown>;
}

/** The button-press half of `/maps` — switches the map and audit-logs it, same as `/map`. */
export async function mapsSelectCallback(ctx: MapsCallbackContext, deps: GatewayDeps): Promise<void> {
  const decoded = decodeMapCallback(ctx.callbackData);
  if (!decoded) {
    await ctx.answerCallbackQuery({ text: 'Unrecognized action.' });
    return;
  }

  const rcon = deps.rconClients.get(decoded.alias);
  if (!rcon) {
    await ctx.answerCallbackQuery({ text: 'Server no longer configured.' });
    return;
  }

  await rcon.map(decoded.mapName);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'map',
    target: decoded.mapName,
    serverAlias: decoded.alias,
    source: 'telegram_button',
  });
  await ctx.editMessageText(`Changing map to ${decoded.mapName}...`);
  await ctx.answerCallbackQuery();
}
