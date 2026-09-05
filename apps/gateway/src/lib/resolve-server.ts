import type { RconClient } from '@cod2admin/rcon-client';
import type { BotContext } from './bot-context.js';
import type { GatewayDeps } from './deps.js';

const SERVER_FLAG = /(?:^|\s)--server\s+(\S+)/;

/** Pulls a trailing `--server <alias>` token out of command text, if present. */
export function extractServerFlag(text: string): { alias: string | undefined; rest: string } {
  const match = SERVER_FLAG.exec(text);
  if (!match) {
    return { alias: undefined, rest: text };
  }
  const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  return { alias: match[1], rest };
}

export interface ResolvedServer {
  alias: string;
  rcon: RconClient;
}

/**
 * Resolves which server a command targets (docs/PLAN.md §4/§6): an explicit `--server <alias>`
 * token, else the current chat's bound server, else the single configured server. Replies with a
 * clear error and returns `undefined` if none of those apply.
 */
export async function resolveServer(
  ctx: BotContext,
  deps: GatewayDeps,
  explicitAlias: string | undefined,
): Promise<ResolvedServer | undefined> {
  let alias = explicitAlias;

  if (!alias && ctx.chat) {
    const bound = await deps.adminStore.getServerForChat(ctx.chat.id);
    alias = bound?.alias;
  }

  if (!alias) {
    if (deps.rconClients.size === 1) {
      alias = deps.rconClients.keys().next().value;
    } else {
      await ctx.reply('Multiple servers configured — specify --server <alias>, or bind this chat with /bindserver.');
      return undefined;
    }
  }

  const rcon = alias ? deps.rconClients.get(alias) : undefined;
  if (!rcon || !alias) {
    await ctx.reply(`Unknown server "${alias}". Run /servers to see what's configured.`);
    return undefined;
  }

  return { alias, rcon };
}
