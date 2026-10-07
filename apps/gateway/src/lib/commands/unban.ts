import { matchText, type BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import { extractServerFlag } from '../resolve-server.js';
import { sanitizeRconArg } from '../sanitize.js';
import { liftBan } from '../unban-actions.js';

/**
 * `/unban <guid-or-ip>` (docs/PLAN.md §6). Bans are global (§7), so this lifts the ban on every
 * server; a `--server` flag is accepted for backwards compatibility but ignored. The work —
 * including taking a permanent GUID ban back out of `ban.txt` — is `liftBan` (unban-actions.ts),
 * shared with the Mini App.
 */
export async function unbanCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  const { rest } = extractServerFlag(matchText(ctx));
  const target = sanitizeRconArg(rest);
  if (!target) {
    await ctx.reply('Usage: /unban <guid-or-ip>');
    return;
  }

  const result = await liftBan(target, deps, {
    telegramId: ctx.admin!.telegramId,
    source: 'telegram_command',
  });

  const what = result.ip ? `IP ${target}` : `GUID ${target}`;
  const lines = [
    result.lifted > 0
      ? `Unbanned ${what} on all servers.`
      : `No active ban for ${what} was recorded by the bot.`,
  ];
  if (result.unanswered.length > 0) {
    lines.push(
      `${result.unanswered.join(', ')} didn't answer, so its ban.txt may still block this player — run /unban ${target} again later.`,
    );
  }
  if (result.notFound.length > 0) {
    lines.push(`No ban.txt entry to remove on ${result.notFound.join(', ')}.`);
  }
  await ctx.reply(lines.join('\n'));
}
