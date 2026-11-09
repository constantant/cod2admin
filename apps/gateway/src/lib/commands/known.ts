import type { KnownPlayer } from '@cod2admin/admin-store';
import type { StatusPlayer } from '@cod2admin/rcon-client';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import {
  KNOWN_PLAYERS_SETTING_KEY,
  normalizeKnownName,
  realGuid,
} from '../known-players.js';
import { parseAsn } from './vpnnets.js';

const USAGE_LINES = {
  status: '/known — the list, and whether it is on',
  toggle: '/known on | off',
  add: '/known add <name> [AS12389 …] [guid:716922 …] — without either, takes the network and GUID of the player now online with that name',
  addAsn: '/known addasn <ASN> <name> — one more network for a known name',
  removeAsn: '/known removeasn <ASN> <name>',
  addGuid:
    '/known addguid <GUID> <name> — a real GUID (most players have 0) beats the network check',
  removeGuid: '/known removeguid <GUID> <name>',
  note: '/known note <name> <text> — a note (empty text clears it)',
  remove: '/known remove <name>',
} as const;

export const KNOWN_USAGE = Object.values(USAGE_LINES).join('\n');

const ASN_TOKEN = /^AS\d{1,10}$/i;
const GUID_TOKEN = /^guid:(\d{1,20})$/i;

function formatIds(asns: number[], guids: string[]): string {
  return [
    ...asns.map((asn) => `AS${asn}`),
    ...guids.map((guid) => `GUID ${guid}`),
  ].join(', ');
}

function formatEntry(entry: KnownPlayer): string {
  const ids = [
    ...entry.asns.map((asn) => `AS${asn}`),
    ...entry.guids.map((guid) => `GUID ${guid}`),
  ].join(', ');
  return `• ${entry.display} — ${ids}${entry.note ? ` (${entry.note})` : ''}`;
}

function formatStatus(deps: GatewayDeps): string {
  const { enabled, entries } = deps.knownPlayers;
  return [
    enabled
      ? 'Known players is ON: a listed name from a listed network is never kicked for a VPN; a listed name from any other network, or with a different real GUID, is kicked on sight. Nobody is banned.'
      : 'Known players is OFF: the list is kept, but nobody is kicked or exempted because of it.',
    '',
    entries.length === 0
      ? 'The list is empty.'
      : ['Known players:', ...entries.map(formatEntry)].join('\n'),
    '',
    KNOWN_USAGE,
  ].join('\n');
}

async function audit(
  ctx: BotContext,
  deps: GatewayDeps,
  action: string,
  target: string | null,
  detail: unknown,
): Promise<void> {
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action,
    target,
    source: 'telegram_command',
    detailJson: detail,
  });
}

async function reload(deps: GatewayDeps): Promise<void> {
  deps.knownPlayers.setEntries(await deps.adminStore.listKnownPlayers());
}

/** The first connected player with this name, on any server. */
async function onlinePlayer(
  deps: GatewayDeps,
  name: string,
): Promise<StatusPlayer | undefined> {
  for (const rcon of deps.rconClients.values()) {
    try {
      const { players } = await rcon.status();
      const found = players.find(
        (player) => normalizeKnownName(player.name) === name,
      );
      if (found) {
        return found;
      }
    } catch {
      // an unreachable server just can't help
    }
  }
  return undefined;
}

/** Trailing `AS12389` / `guid:716922` words are identities; what's before them is the name. */
function splitName(tokens: string[]): {
  name: string;
  asns: number[];
  guids: string[];
} {
  const asns: number[] = [];
  const guids: string[] = [];
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    const guid = GUID_TOKEN.exec(last)?.[1];
    if (guid) {
      guids.unshift(guid);
    } else if (ASN_TOKEN.test(last)) {
      asns.unshift(parseAsn(last)!);
    } else {
      break;
    }
    tokens.pop();
  }
  return { name: tokens.join(' '), asns, guids };
}

/**
 * `/known` — nicknames tied to the provider networks (ASNs) their owner connects from
 * (known-players.ts, docs/PLAN-known-players.md). Saved in the database, applied at once.
 */
export async function knownCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  const text = matchText(ctx);
  const [subcommand = ''] = text.split(/\s+/);
  const rest = text.slice(subcommand.length).trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  const actor = ctx.admin!.telegramId;
  const find = (name: string) =>
    deps.knownPlayers.entries.find((entry) => entry.name === name);
  const offNote = deps.knownPlayers.enabled
    ? ''
    : '\n\nIt is saved, but /known is off — turn it on with /known on.';

  switch (subcommand.toLowerCase()) {
    case '': {
      await ctx.reply(formatStatus(deps));
      return;
    }

    case 'on':
    case 'off': {
      const enabled = subcommand.toLowerCase() === 'on';
      await deps.adminStore.setSetting(KNOWN_PLAYERS_SETTING_KEY, { enabled });
      deps.knownPlayers.setEnabled(enabled);
      await audit(ctx, deps, 'known', null, { enabled });
      await ctx.reply(formatStatus(deps).split('\n')[0]!);
      return;
    }

    case 'add': {
      const {
        name: display,
        asns: givenAsns,
        guids: givenGuids,
      } = splitName(tokens);
      const name = display ? normalizeKnownName(display) : '';
      if (!name) {
        await ctx.reply(`Usage: ${USAGE_LINES.add}`);
        return;
      }
      const asns = [...givenAsns];
      const guids = [...givenGuids];
      if (asns.length === 0 && guids.length === 0) {
        const online = await onlinePlayer(deps, name);
        const guid = online ? realGuid(online) : undefined;
        const asn = online?.ip ? deps.provider.asn(online.ip) : undefined;
        if (asn === undefined && guid === undefined) {
          await ctx.reply(
            `${display} isn't online (or has no known network or GUID). Name the identity yourself, e.g. /known add ${display} AS12389.`,
          );
          return;
        }
        if (asn !== undefined) asns.push(asn);
        if (guid !== undefined) guids.push(guid);
      }
      const existing = find(name);
      const mergedAsns = [...new Set([...(existing?.asns ?? []), ...asns])];
      const mergedGuids = [...new Set([...(existing?.guids ?? []), ...guids])];
      await deps.adminStore.saveKnownPlayer({
        name,
        display: existing?.display ?? display,
        asns: mergedAsns,
        guids: mergedGuids,
        note: existing?.note ?? null,
        createdBy: actor,
      });
      await reload(deps);
      await audit(ctx, deps, 'known_add', name, { asns, guids });
      await ctx.reply(
        `${display} is known: ${formatIds(mergedAsns, mergedGuids)}.${offNote}`,
      );
      return;
    }

    case 'addasn':
    case 'removeasn':
    case 'addguid':
    case 'removeguid': {
      const adding = subcommand.toLowerCase().startsWith('add');
      const isGuid = subcommand.toLowerCase().endsWith('guid');
      const idText = tokens[0] ?? '';
      const asn = isGuid ? undefined : parseAsn(idText);
      const guid =
        isGuid && /^\d{1,20}$/.test(idText) && idText !== '0'
          ? idText
          : undefined;
      const display = tokens.slice(1).join(' ');
      const entry = display ? find(normalizeKnownName(display)) : undefined;
      const usage =
        USAGE_LINES[subcommand.toLowerCase() as keyof typeof USAGE_LINES];
      const label = isGuid ? `GUID ${guid}` : `AS${asn}`;
      if ((asn === undefined && guid === undefined) || !entry) {
        await ctx.reply(
          (asn !== undefined || guid !== undefined) && display
            ? `${display} isn't in the list — add it with /known add first.`
            : `Usage: ${usage}`,
        );
        return;
      }
      const has = isGuid
        ? entry.guids.includes(guid!)
        : entry.asns.includes(asn!);
      if (adding === has) {
        await ctx.reply(
          adding
            ? `${entry.display} already has ${label}.`
            : `${entry.display} doesn't have ${label}.`,
        );
        return;
      }
      const toggle = <T>(list: T[], value: T) =>
        adding
          ? [...list, value]
          : list.filter((existing) => existing !== value);
      const asns = isGuid ? entry.asns : toggle(entry.asns, asn!);
      const guids = isGuid ? toggle(entry.guids, guid!) : entry.guids;
      if (asns.length === 0 && guids.length === 0) {
        await ctx.reply(
          `That is the last identity of ${entry.display} — use /known remove ${entry.display} to delete the entry.`,
        );
        return;
      }
      await deps.adminStore.saveKnownPlayer({
        name: entry.name,
        display: entry.display,
        asns,
        guids,
        note: entry.note,
        createdBy: actor,
      });
      await reload(deps);
      await audit(
        ctx,
        deps,
        `known_${isGuid ? 'guid' : 'asn'}_${adding ? 'add' : 'remove'}`,
        entry.name,
        isGuid ? { guid } : { asn },
      );
      await ctx.reply(`${entry.display}: ${formatIds(asns, guids)}.`);
      return;
    }

    case 'note': {
      // The name may contain spaces, so the note is whatever follows the longest listed name.
      const entry = deps.knownPlayers.entries
        .filter((candidate) =>
          normalizeKnownName(rest).startsWith(candidate.name),
        )
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (!entry) {
        await ctx.reply(`Usage: ${USAGE_LINES.note}`);
        return;
      }
      const note = rest.slice(entry.display.length).trim() || null;
      await deps.adminStore.saveKnownPlayer({
        name: entry.name,
        display: entry.display,
        asns: entry.asns,
        guids: entry.guids,
        note,
        createdBy: actor,
      });
      await reload(deps);
      await audit(ctx, deps, 'known_note', entry.name, { note });
      await ctx.reply(
        note
          ? `Note saved for ${entry.display}.`
          : `Note cleared for ${entry.display}.`,
      );
      return;
    }

    case 'remove': {
      const entry = rest ? find(normalizeKnownName(rest)) : undefined;
      if (!entry) {
        await ctx.reply(
          `${rest ? `${rest} isn't in the list.` : `Usage: ${USAGE_LINES.remove}`}`,
        );
        return;
      }
      await deps.adminStore.deleteKnownPlayer(entry.name);
      await reload(deps);
      await audit(ctx, deps, 'known_remove', entry.name, {
        asns: entry.asns,
        guids: entry.guids,
      });
      await ctx.reply(`${entry.display} is no longer a known player.`);
      return;
    }

    default:
      await ctx.reply(KNOWN_USAGE);
  }
}
