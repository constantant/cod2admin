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

const MAP_ROTATION_VALUE = /is:\s*"([^"]*)"/;
const MAP_ROTATION_ENTRY = /\bmap\s+(\S+)/gi;

/**
 * Extracts map names from a `rcon sv_mapRotation` response, e.g.
 * `"sv_mapRotation" is: "gametype tdm map mp_brecourt gametype ctf map mp_carentan^7" default: "^7"`
 * (confirmed against a real server 2026-09-08) — order-preserved, de-duplicated. There's no
 * RCON-exposed way to list every map installed on disk (stock maps ship packed inside the game's
 * own pak files, not as loose files), so the configured rotation is the practical "maps available
 * to switch to" list.
 */
export function parseMapRotation(raw: string): string[] {
  const value = stripColorCodes(MAP_ROTATION_VALUE.exec(raw)?.[1] ?? '');
  const maps: string[] = [];
  for (const match of value.matchAll(MAP_ROTATION_ENTRY)) {
    if (!maps.includes(match[1])) {
      maps.push(match[1]);
    }
  }
  return maps;
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

/**
 * The engine prints a UDP port (unsigned 16-bit, 0-65535) through a signed 16-bit formatter,
 * so any port above 32767 comes back as a negative decimal (e.g. `52931` prints as `-12605`;
 * confirmed against a real server, docs/PLAN.md §2.4). Undo that wraparound here rather than
 * exposing the raw signed value to callers.
 */
function unwrapSignedPort(port: number | undefined): number | undefined {
  return port !== undefined && port < 0 ? port + 65536 : port;
}

function fieldsToPlayer(fields: Record<string, string>): StatusPlayer | null {
  const num = toInt(fields['num']);
  if (num === undefined) {
    return null;
  }
  const address = fields['address'] ?? '';
  const lastColon = address.lastIndexOf(':');
  const ip = lastColon > -1 ? address.slice(0, lastColon) : address || undefined;
  const port = lastColon > -1 ? unwrapSignedPort(toInt(address.slice(lastColon + 1))) : undefined;

  return {
    num,
    score: toInt(fields['score']) ?? 0,
    ping: toInt(fields['ping']) ?? 0,
    name: stripColorCodes(fields['name'] ?? '').trim(),
    guid: fields['guid'] || undefined,
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
  // Column widths can't be trusted for any data row (docs/PLAN.md §2.4, quirk (a) and the
  // 2026-10-04 note): some builds print rows a character or more off from their own header, and a
  // name longer than its column — common once color codes count, e.g. `^^20Persian^^51Gulf^7` —
  // pushes everything after it to the right. But `name` is the only column that can contain
  // whitespace; every other value is a single token. So the columns before `name` are the first
  // tokens of the line, the columns after it are the last tokens, and the name is exactly the
  // text between them, embedded spaces and all.
  const nameIndex = columnNames.indexOf('name');

  const players: StatusPlayer[] = [];
  for (let i = separatorIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      continue;
    }
    const fields: Record<string, string> = {};
    if (nameIndex === -1) {
      // No name column to anchor on: fall back to the header's fixed widths.
      columns.forEach(({ start, end }, idx) => {
        const isLastColumn = idx === columns.length - 1;
        fields[columnNames[idx]] = (isLastColumn ? line.slice(start) : line.slice(start, end)).trim();
      });
    } else {
      const tokens = [...line.matchAll(/\S+/g)];
      const before = columnNames.slice(0, nameIndex);
      const after = columnNames.slice(nameIndex + 1);
      if (tokens.length < before.length + after.length) {
        continue; // not a player row (truncated or malformed)
      }
      before.forEach((columnName, idx) => {
        fields[columnName] = tokens[idx][0];
      });
      const afterTokens = tokens.slice(tokens.length - after.length);
      after.forEach((columnName, idx) => {
        fields[columnName] = afterTokens[idx][0];
      });
      const lastBefore = tokens[before.length - 1];
      const nameStart = lastBefore ? lastBefore.index + lastBefore[0].length : 0;
      const nameEnd = afterTokens.length > 0 ? afterTokens[0].index : line.length;
      fields['name'] = line.slice(nameStart, nameEnd).trim();
    }
    const player = fieldsToPlayer(fields);
    if (player) {
      players.push(player);
    }
  }

  return { raw, mapName, hostname, players };
}
