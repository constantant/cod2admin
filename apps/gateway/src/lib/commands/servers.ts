import type { ServerConfig } from '@cod2admin/admin-store';
import type { BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

function formatServerLine(server: ServerConfig, bootstrapAlias: string | undefined): string {
  const notes = [
    server.isDefault ? 'default' : undefined,
    server.alias === bootstrapAlias ? 'from config file' : undefined,
    server.boundTelegramChatId ? `bound to chat ${server.boundTelegramChatId}` : undefined,
  ].filter(Boolean);
  const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
  return `${server.alias} — ${server.rconHost}:${server.rconPort}${suffix}`;
}

export function formatServersMessage(servers: ServerConfig[], bootstrapAlias?: string): string {
  if (servers.length === 0) {
    return 'No servers configured.';
  }
  return servers.map((server) => formatServerLine(server, bootstrapAlias)).join('\n');
}

/** `/servers` — lists configured servers (docs/PLAN.md §4). */
export async function serversCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const servers = await deps.adminStore.listServers();
  await ctx.reply(formatServersMessage(servers, deps.bootstrapServerAlias));
}
