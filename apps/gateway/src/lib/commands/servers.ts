import type { ServerConfig } from '@cod2admin/admin-store';
import type { BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

function formatServerLine(server: ServerConfig): string {
  const bound = server.boundTelegramChatId ? ` (bound to chat ${server.boundTelegramChatId})` : '';
  return `${server.alias} — ${server.rconHost}:${server.rconPort}${bound}`;
}

export function formatServersMessage(servers: ServerConfig[]): string {
  if (servers.length === 0) {
    return 'No servers configured.';
  }
  return servers.map(formatServerLine).join('\n');
}

/** `/servers` — lists configured servers (docs/PLAN.md §4). */
export async function serversCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const servers = await deps.adminStore.listServers();
  await ctx.reply(formatServersMessage(servers));
}
