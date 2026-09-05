import type { RconClient, StatusPlayer } from '@cod2admin/rcon-client';
import type { BotContext } from '../bot-context.js';

function formatPlayerLine(player: StatusPlayer): string {
  const ip = player.ip ?? 'unknown';
  return `#${player.num} ${player.name} — score ${player.score}, ping ${player.ping}, ip ${ip}`;
}

/** Formats the `/players` list — detailed `rcon status` table, includes IPs (docs/PLAN.md §6). */
export function formatPlayersMessage(players: StatusPlayer[]): string {
  if (players.length === 0) {
    return 'No players connected.';
  }
  return players.map(formatPlayerLine).join('\n');
}

export async function playersCommand(ctx: BotContext, rcon: RconClient): Promise<void> {
  const { players } = await rcon.status();
  await ctx.reply(formatPlayersMessage(players));
}
