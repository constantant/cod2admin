import type { KnownPlayer } from '@cod2admin/admin-store';
import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import {
  KNOWN_PLAYERS_SETTING_KEY,
  normalizeKnownName,
} from '../known-players.js';
import { parseAsn } from './vpnnets.js';

export const KNOWN_USAGE = [
  '/known — the list, and whether it is on',
  '/known on | off',
  '/known add <name> [AS12389 …] — without an ASN, takes the one of the player now online with that name',
  '/known addasn <ASN> <name> — one more network for a known name',
  '/known removeasn <ASN> <name>',
  '/known note <name> <text> — a note (empty text clears it)',
  '/known remove <name>',
].join('\n');

const ASN_TOKEN = /^AS\d{1,10}$/i;

function formatEntry(entry: KnownPlayer): string {
  const asns = entry.asns.map((asn) => `AS${asn}`).join(', ');
  return `• ${entry.display} — ${asns}${entry.note ? ` (${entry.note})` : ''}`;
}

function formatStatus(deps: GatewayDeps): string {
  const { enabled, entries } = deps.knownPlayers;
  return [
    enabled
      ? 'Known players is ON: a listed name from a listed network is never kicked for a VPN; a listed name from any other network is kicked on sight. Nobody is banned.'
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

/** The provider network of the first connected player with this name, on any server. */
async function asnOfOnlinePlayer(
  deps: GatewayDeps,
  name: string,
): Promise<number | undefined> {
  for (const rcon of deps.rconClients.values()) {
    try {
      const { players } = await rcon.status();
      for (const player of players) {
        if (normalizeKnownName(player.name) === name && player.ip) {
          const asn = deps.provider.asn(player.ip);
          if (asn !== undefined) {
            return asn;
          }
        }
      }
    } catch {
      // an unreachable server just can't help
    }
  }
  return undefined;
}

/** Last word of the text if it parses as an ASN, e.g. `Vasya AS12389` — otherwise the whole text. */
function splitName(tokens: string[]): { name: string; asns: number[] } {
  const asns: number[] = [];
  while (tokens.length > 1 && ASN_TOKEN.test(tokens[tokens.length - 1]!)) {
    asns.unshift(parseAsn(tokens.pop()!)!);
  }
  return { name: tokens.join(' '), asns };
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
      const { name: display, asns: given } = splitName(tokens);
      const name = display ? normalizeKnownName(display) : '';
      if (!name) {
        await ctx.reply(`Usage: ${KNOWN_USAGE.split('\n')[2]}`);
        return;
      }
      const asns = [...given];
      if (asns.length === 0) {
        const online = await asnOfOnlinePlayer(deps, name);
        if (online === undefined) {
          await ctx.reply(
            `${display} isn't online (or has no known network). Name the networks yourself, e.g. /known add ${display} AS12389.`,
          );
          return;
        }
        asns.push(online);
      }
      const existing = find(name);
      const merged = [...new Set([...(existing?.asns ?? []), ...asns])];
      await deps.adminStore.saveKnownPlayer({
        name,
        display: existing?.display ?? display,
        asns: merged,
        note: existing?.note ?? null,
        createdBy: actor,
      });
      await reload(deps);
      await audit(ctx, deps, 'known_add', name, { asns });
      await ctx.reply(
        `${display} is known on ${merged.map((asn) => `AS${asn}`).join(', ')}.${offNote}`,
      );
      return;
    }

    case 'addasn':
    case 'removeasn': {
      const adding = subcommand.toLowerCase() === 'addasn';
      const asn = parseAsn(tokens[0] ?? '');
      const display = tokens.slice(1).join(' ');
      const entry = display ? find(normalizeKnownName(display)) : undefined;
      if (asn === undefined || !entry) {
        await ctx.reply(
          asn !== undefined && display
            ? `${display} isn't in the list — add it with /known add first.`
            : `Usage: ${KNOWN_USAGE.split('\n')[adding ? 3 : 4]}`,
        );
        return;
      }
      const has = entry.asns.includes(asn);
      if (adding === has) {
        await ctx.reply(
          adding
            ? `${entry.display} already has AS${asn}.`
            : `${entry.display} doesn't have AS${asn}.`,
        );
        return;
      }
      const asns = adding
        ? [...entry.asns, asn]
        : entry.asns.filter((existing) => existing !== asn);
      if (asns.length === 0) {
        await ctx.reply(
          `That is the last network of ${entry.display} — use /known remove ${entry.display} to delete the entry.`,
        );
        return;
      }
      await deps.adminStore.saveKnownPlayer({
        name: entry.name,
        display: entry.display,
        asns,
        note: entry.note,
        createdBy: actor,
      });
      await reload(deps);
      await audit(ctx, deps, adding ? 'known_asn_add' : 'known_asn_remove', entry.name, { asn });
      await ctx.reply(`${entry.display}: ${asns.map((a) => `AS${a}`).join(', ')}.`);
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
        await ctx.reply(`Usage: ${KNOWN_USAGE.split('\n')[5]}`);
        return;
      }
      const note = rest.slice(entry.display.length).trim() || null;
      await deps.adminStore.saveKnownPlayer({
        name: entry.name,
        display: entry.display,
        asns: entry.asns,
        note,
        createdBy: actor,
      });
      await reload(deps);
      await audit(ctx, deps, 'known_note', entry.name, { note });
      await ctx.reply(note ? `Note saved for ${entry.display}.` : `Note cleared for ${entry.display}.`);
      return;
    }

    case 'remove': {
      const entry = rest ? find(normalizeKnownName(rest)) : undefined;
      if (!entry) {
        await ctx.reply(`${rest ? `${rest} isn't in the list.` : `Usage: ${KNOWN_USAGE.split('\n')[6]}`}`);
        return;
      }
      await deps.adminStore.deleteKnownPlayer(entry.name);
      await reload(deps);
      await audit(ctx, deps, 'known_remove', entry.name, { asns: entry.asns });
      await ctx.reply(`${entry.display} is no longer a known player.`);
      return;
    }

    default:
      await ctx.reply(KNOWN_USAGE);
  }
}

