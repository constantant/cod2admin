import { existsSync } from 'node:fs';
import path from 'node:path';
import { stripColorCodes } from '@cod2admin/rcon-client';

const SAFE_MAP_NAME = /^[A-Za-z0-9_]{1,64}$/;
const SCORE_COMMAND = /^d (5|6) (-?\d+)$/;
const MIN_EFFICIENT_MINUTES = 2;
const TOP = 3;
const NAME_MAX = 24;
const CAPTION_MAX = 1024;
const TEAM_SPECTATOR = 3;

export interface MatchPlayer {
  name: string;
  /** Status slot. Used when the name is only colour codes. */
  num: number;
  score: number;
  /** Minutes between the first and last status sample on this map. */
  minutes: number;
  /** Snapshot team. Null when the spectator has not reported the slot. */
  team: number | null;
  bot: boolean;
}

export interface MatchCaptionInput {
  mapName: string;
  axis: number | null;
  allies: number | null;
  players: readonly MatchPlayer[];
}

/** `d 5 <n>` is Axis, `d 6 <n>` is Allies. Anything else is not a score. */
export function parseScoreCommand(
  text: string,
): { index: 5 | 6; value: number } | undefined {
  const match = SCORE_COMMAND.exec(text.trim());
  if (!match) return undefined;
  const index = Number(match[1]);
  const value = Number(match[2]);
  if ((index !== 5 && index !== 6) || Math.abs(value) > 1_000_000) {
    return undefined;
  }
  return { index, value };
}

/**
 * Plain-text caption for one finished map. Null when there is nothing to say:
 * nobody scored, and the team score is missing or still 0–0.
 * Spectators and the game bot are left out. Team 0 (deathmatch) stays in.
 */
export function buildMatchCaption(input: MatchCaptionInput): string | null {
  const ranked = input.players.filter(
    (player) => !player.bot && player.team !== TEAM_SPECTATOR,
  );
  const scored = ranked
    .filter((player) => player.score > 0)
    .sort(
      (a, b) => b.score - a.score || plainName(a).localeCompare(plainName(b)),
    );
  const teamLine = teamScoreLine(input.axis, input.allies);
  if (scored.length === 0 && !teamLine) return null;

  const lines = [prettyMapName(input.mapName)];
  if (teamLine) lines.push(teamLine);
  if (scored.length > 0) {
    if (teamLine) lines.push('');
    lines.push('Top scores');
    for (const [index, player] of scored.slice(0, TOP).entries()) {
      lines.push(`${index + 1}. ${plainName(player)} — ${player.score}`);
    }
  }
  const efficient = ranked
    .filter(
      (player) => player.score > 0 && player.minutes >= MIN_EFFICIENT_MINUTES,
    )
    .map((player) => ({ player, rate: player.score / player.minutes }))
    .sort(
      (a, b) =>
        b.rate - a.rate ||
        b.player.score - a.player.score ||
        plainName(a.player).localeCompare(plainName(b.player)),
    );
  if (efficient.length > 0) {
    if (scored.length > 0 || teamLine) lines.push('');
    lines.push('Most points per minute');
    for (const [index, row] of efficient.slice(0, TOP).entries()) {
      lines.push(
        `${index + 1}. ${plainName(row.player)} — ${row.player.score} points in ${formatMinutes(row.player.minutes)}`,
      );
    }
  }
  const text = lines.join('\n');
  if (text.length <= CAPTION_MAX) return text;
  return `${text.slice(0, CAPTION_MAX - 1)}…`;
}

/** First existing `<map>.webp` under the roots. An unsafe name matches nothing. */
export function resolveMapPreview(
  mapName: string,
  roots: readonly string[],
  exists: (file: string) => boolean = existsSync,
): string | null {
  if (!SAFE_MAP_NAME.test(mapName)) return null;
  const fileName = `${mapName}.webp`;
  for (const root of roots) {
    const full = path.join(root, fileName);
    if (exists(full)) return full;
  }
  return null;
}

export function prettyMapName(name: string): string {
  const safe = SAFE_MAP_NAME.test(name) ? name : 'map';
  return (
    safe
      .replace(/^mp_/i, '')
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Map'
  );
}

function teamScoreLine(
  axis: number | null,
  allies: number | null,
): string | null {
  if (axis === null || allies === null) return null;
  if (axis === 0 && allies === 0) return null;
  return `Axis ${axis} — Allies ${allies}`;
}

function formatMinutes(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes));
  return `${rounded} min`;
}

/**
 * The nick with Quake colour codes removed, including the doubled `^^11` form.
 * One `stripColorCodes` pass leaves `^1` behind, and repeating it is what
 * `/players` does. Empty when the name was only colour codes.
 */
export function readableName(name: string): string {
  let plain = name.trim();
  for (let pass = 0; pass < 8; pass++) {
    const next = stripColorCodes(plain.replace(/\^\^(\d)\1/g, '')).trim();
    if (next === plain) return plain.replace(/\^+$/g, '').trim();
    plain = next;
  }
  return plain.replace(/\^+$/g, '').trim();
}

function plainName(player: MatchPlayer): string {
  const plain = readableName(player.name);
  const text = plain || `#${player.num}`;
  if (text.length <= NAME_MAX) return text;
  return `${text.slice(0, NAME_MAX - 1)}…`;
}
