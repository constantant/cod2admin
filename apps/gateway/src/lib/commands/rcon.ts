import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import {
  markdownCodeBlock,
  replyWithReport,
  reportDocument,
  reportFileName,
  truncateText,
  type LongReply,
} from '../long-reply.js';
import { extractServerFlag, resolveServer } from '../resolve-server.js';

/**
 * `/rcon <raw command> [--server <alias>]` — owner-only raw passthrough (docs/PLAN.md §6/§8).
 * The one intentional exception to sanitizing rcon arguments — logged verbatim regardless.
 */
export async function rconCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  const { alias: serverAlias, rest } = extractServerFlag(matchText(ctx));
  const server = await resolveServer(ctx, deps, serverAlias);
  if (!server) {
    return;
  }

  if (!rest) {
    await ctx.reply('Usage: /rcon <raw command> [--server <alias>]');
    return;
  }

  const result = await server.rcon.rcon(rest);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'rcon',
    target: rest,
    serverAlias: server.alias,
    source: 'telegram_command',
    detailJson: { command: rest },
  });
  await replyWithReport(ctx, buildRconReply(rest, server.alias, result || '(no output)'));
}

/** How many output lines the short `/rcon` reply shows before pointing at the attached file. */
const SUMMARY_LINES = 20;

export function buildRconReply(command: string, serverAlias: string, output: string, now: Date = new Date()): LongReply {
  const lines = output.split('\n');
  const shown = lines.slice(0, SUMMARY_LINES).join('\n');
  return {
    full: output,
    summary: `${truncateText(shown, 3000)}\n\n… ${lines.length} lines in total — full output in the attached file.`,
    markdown: reportDocument({
      title: `rcon output — ${serverAlias}`,
      meta: [`Server: ${serverAlias}`, `Command: ${command.replace(/[\r\n]+/g, ' ')}`],
      body: markdownCodeBlock(output),
      now,
    }),
    fileName: reportFileName('rcon', serverAlias, now),
  };
}
