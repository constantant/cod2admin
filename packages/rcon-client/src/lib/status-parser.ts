import type { CvarMap, OobStatusPlayer, ServerStatus, StatusPlayer } from './types.js';

/** Strips Quake/CoD `^`-digit color codes (e.g. `^1Player^7One` -> `PlayerOne`). */
export function stripColorCodes(value: string): string {
  return value.replace(/\^[0-9]/g, '');
}

/** Parses a `\key\value\key\value` cvar block, as returned by `getinfo`/`getstatus`. */
export function parseCvarBlock(block: string): CvarMap {
  const trimmed = block.startsWith('\\') ? block.slice(1) : block;
  if (trimmed === '') {
    return {};
  }
  const tokens = trimmed.split('\\');
  const cvars: CvarMap = {};
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    cvars[tokens[i]] = tokens[i + 1];
  }
  return cvars;
}

const OOB_PLAYER_LINE = /^(-?\d+)\s+(-?\d+)\s+"(.*)"$/;

/** Parses one player line from a `getstatus` OOB response, e.g. `5 42 "PlayerOne"`. */
export function parseOobPlayerLine(line: string): OobStatusPlayer | null {
  const match = OOB_PLAYER_LINE.exec(line.trim());
  if (!match) {
    return null;
  }
  return {
    score: Number.parseInt(match[1], 10),
    ping: Number.parseInt(match[2], 10),
    name: match[3],
  };
}

interface ColumnBounds {
  start: number;
  end: number;
}

/**
 * Derives column start/end offsets from the `--- ----- ----` separator line under the
 * `status` table header, rather than hardcoding widths — CoD2/Q3-family status tables have
 * historically varied column sets/widths across games and mods.
 *
 * Known limitation: a value wider than its header's dash run (e.g. a long player name) will
 * overflow into the next column's slice. Refine against real fixtures captured per
 * docs/PLAN.md §11.2 once available.
 */
function columnBoundsFromSeparator(separatorLine: string): ColumnBounds[] {
  const bounds: ColumnBounds[] = [];
  const dashRun = /-+/g;
  let match: RegExpExecArray | null;
  while ((match = dashRun.exec(separatorLine)) !== null) {
    bounds.push({ start: match.index, end: match.index + match[0].length });
  }
  return bounds;
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? undefined : n;
}

function fieldsToPlayer(fields: Record<string, string>): StatusPlayer | null {
  const num = toInt(fields['num']);
  if (num === undefined) {
    return null;
  }
  const address = fields['address'] ?? '';
  const lastColon = address.lastIndexOf(':');
  const ip = lastColon > -1 ? address.slice(0, lastColon) : address || undefined;
  const port = lastColon > -1 ? toInt(address.slice(lastColon + 1)) : undefined;

  return {
    num,
    score: toInt(fields['score']) ?? 0,
    ping: toInt(fields['ping']) ?? 0,
    name: stripColorCodes(fields['name'] ?? '').trim(),
    lastmsg: toInt(fields['lastmsg']),
    ip,
    port,
    qport: toInt(fields['qport']),
    rate: toInt(fields['rate']),
  };
}

/**
 * Parses the text response of `rcon status` — the detailed player table (with IPs) used for
 * report enrichment (docs/PLAN.md §5.3), as opposed to the public OOB `getstatus` query.
 */
export function parseRconStatusTable(raw: string): ServerStatus {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');

  let mapName: string | undefined;
  let hostname: string | undefined;
  let separatorIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mapMatch = /^map:\s*(.+)$/i.exec(line);
    if (mapMatch) {
      mapName = mapMatch[1].trim();
    }
    const hostMatch = /^hostname:\s*(.+)$/i.exec(line);
    if (hostMatch) {
      hostname = hostMatch[1].trim();
    }
    if (i > 0 && /^-{2,}(\s+-{2,})*\s*$/.test(line.trim())) {
      separatorIndex = i;
      break;
    }
  }

  if (separatorIndex === -1) {
    return { raw, mapName, hostname, players: [] };
  }

  const headerLine = lines[separatorIndex - 1];
  const columns = columnBoundsFromSeparator(lines[separatorIndex]);
  const columnNames = columns.map(({ start, end }) => headerLine.slice(start, end).trim().toLowerCase());

  const players: StatusPlayer[] = [];
  for (let i = separatorIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      continue;
    }
    const fields: Record<string, string> = {};
    columns.forEach(({ start, end }, idx) => {
      const isLastColumn = idx === columns.length - 1;
      const value = isLastColumn ? line.slice(start) : line.slice(start, end);
      fields[columnNames[idx]] = value.trim();
    });
    const player = fieldsToPlayer(fields);
    if (player) {
      players.push(player);
    }
  }

  return { raw, mapName, hostname, players };
}
