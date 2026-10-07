import type { AdminRole } from '@cod2admin/admin-store';
import type { RconClient } from '@cod2admin/rcon-client';
import { InlineKeyboard } from 'grammy';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';

const MAPS_PER_ROW = 2;
/** Telegram caps a button's callback data at 64 bytes; a map whose callback won't fit gets no button. */
const CALLBACK_DATA_LIMIT = 64;
/** More buttons than this make the message unwieldy — the rest can still be switched to with `/map`. */
const MAX_OTHER_MAP_BUTTONS = 60;

/**
 * The maps every CoD2 1.3 install has — the dev server's full `dir maps/mp d3dbsp` list
 * (2026-10-07). Anything else is a custom map that players may not have, so switching to one gets
 * a confirmation step: unless the server offers downloads, players without it can be dropped.
 */
export const STOCK_MAPS: ReadonlySet<string> = new Set([
  'mp_breakout',
  'mp_brecourt',
  'mp_burgundy',
  'mp_carentan',
  'mp_dawnville',
  'mp_decoy',
  'mp_downtown',
  'mp_farmhouse',
  'mp_harbor',
  'mp_leningrad',
  'mp_matmata',
  'mp_railyard',
  'mp_rhine',
  'mp_toujane',
  'mp_trainstation',
]);

export const CUSTOM_MAP_WARNING =
  'not a standard CoD2 map: players who don\'t have it may be dropped unless the server offers downloads';

type MapAction = 'map' | 'mapask' | 'mapno';
const MAP_CALLBACK = /^(map|mapask|mapno):(.+):([^:]+)$/;

function encodeMapCallback(action: MapAction, alias: string, mapName: string): string {
  return `${action}:${alias}:${mapName}`;
}

function decodeMapCallback(data: string): { action: MapAction; alias: string; mapName: string } | null {
  const match = MAP_CALLBACK.exec(data);
  return match ? { action: match[1] as MapAction, alias: match[2]!, mapName: match[3]! } : null;
}

function fitsCallback(alias: string, mapName: string): boolean {
  return Buffer.byteLength(encodeMapCallback('mapask', alias, mapName)) <= CALLBACK_DATA_LIMIT;
}

/** `warnCustom`: off for the rotation — the server already cycles through those, custom or not. */
function buildMapKeyboard(alias: string, maps: string[], warnCustom: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  maps.forEach((mapName, index) => {
    const custom = warnCustom && !STOCK_MAPS.has(mapName);
    keyboard.text(custom ? `⚠ ${mapName}` : mapName, encodeMapCallback(custom ? 'mapask' : 'map', alias, mapName));
    if ((index + 1) % MAPS_PER_ROW === 0) {
      keyboard.row();
    }
  });
  return keyboard;
}

/** Every installed map, or `[]` if the server doesn't answer `dir` the way we expect. */
async function installedMaps(rcon: RconClient): Promise<string[]> {
  try {
    return await rcon.getInstalledMaps();
  } catch (error) {
    console.error('Listing installed maps failed:', error);
    return [];
  }
}

/**
 * `/maps [--server <alias>]` — tap-to-switch buttons (docs/PLAN.md §6): first the maps in
 * `sv_mapRotation`, then every other map installed on the server (`dir maps/mp d3dbsp`), where a
 * non-standard map (⚠) asks for confirmation first.
 */
export async function mapsCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  const [rotation, installed] = await Promise.all([server.rcon.getMapRotation(), installedMaps(server.rcon)]);
  const inRotation = new Set(rotation);
  const others = installed.filter((mapName) => !inRotation.has(mapName) && fitsCallback(server.alias, mapName));

  if (rotation.length === 0 && others.length === 0) {
    await ctx.reply('No maps found in sv_mapRotation or on the server.');
    return;
  }

  if (rotation.length > 0) {
    await ctx.reply('Maps in rotation — tap one to switch to it:', {
      reply_markup: buildMapKeyboard(server.alias, rotation, false),
    });
  }
  if (others.length > 0) {
    const shown = others.slice(0, MAX_OTHER_MAP_BUTTONS);
    const lines = [`Other maps installed on ${server.alias} (${others.length}, not in rotation):`];
    if (shown.some((mapName) => !STOCK_MAPS.has(mapName))) {
      lines.push(`⚠ = ${CUSTOM_MAP_WARNING}. You'll be asked to confirm.`);
    }
    if (others.length > shown.length) {
      lines.push(`Showing ${shown.length}; switch to the others with /map <name>.`);
    }
    await ctx.reply(lines.join('\n'), { reply_markup: buildMapKeyboard(server.alias, shown, true) });
  }
}

/** Structural subset of grammy's callback-query `Context` (mirrors `ReportCallbackContext`'s approach). */
export interface MapsCallbackContext {
  admin?: { telegramId: number; role: AdminRole };
  callbackData: string;
  editMessageText(text: string, other?: unknown): Promise<unknown>;
  answerCallbackQuery(other?: { text?: string }): Promise<unknown>;
}

/**
 * The button-press half of `/maps`: `map:` switches the map and audit-logs it, same as `/map`;
 * `mapask:` (a custom map) asks first; `mapno:` cancels that question.
 */
export async function mapsSelectCallback(ctx: MapsCallbackContext, deps: GatewayDeps): Promise<void> {
  const decoded = decodeMapCallback(ctx.callbackData);
  if (!decoded) {
    await ctx.answerCallbackQuery({ text: 'Unrecognized action.' });
    return;
  }

  if (decoded.action === 'mapno') {
    await ctx.editMessageText(`Map change to ${decoded.mapName} cancelled.`);
    await ctx.answerCallbackQuery();
    return;
  }

  if (decoded.action === 'mapask') {
    const keyboard = new InlineKeyboard()
      .text(`✅ Switch to ${decoded.mapName}`, encodeMapCallback('map', decoded.alias, decoded.mapName))
      .text('Cancel', encodeMapCallback('mapno', decoded.alias, decoded.mapName));
    await ctx.editMessageText(`Switch ${decoded.alias} to ${decoded.mapName}? It's ${CUSTOM_MAP_WARNING}.`, {
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery();
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
