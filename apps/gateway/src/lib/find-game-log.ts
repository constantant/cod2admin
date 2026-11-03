import { readFileTail } from '@cod2admin/log-tailer';
import {
  parseCvarBlock,
  stripColorCodes,
  type RconClient,
} from '@cod2admin/rcon-client';
import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const DEFAULT_LOG_NAME = 'games_mp.log';
/** Enough to reach back to the current map's `InitGame` line on a busy server. */
const VERIFY_TAIL_BYTES = 1024 * 1024;
const MAX_DIR_DEPTH = 8;
const MAX_DIRS = 50_000;
const MAX_SEARCH_MS = 20_000;

/** System and generated folders no game server keeps its log in. */
const SKIPPED_PATHS: ReadonlySet<string> = new Set([
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/tmp',
  '/usr',
  '/var/cache',
  '/var/lib/docker',
  '/var/lib/postgresql',
]);
const SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.cache',
  '.git',
  'node_modules',
]);

const CVAR_REPLY = /"[^"]+"\s+is:\s*"([^"]*)"/;

/**
 * The value from an rcon cvar reply such as `"fs_homepath" is: "/home/cod2^7" default: "^7"`.
 * `undefined` when the reply isn't one (an unknown cvar, or a rejected password).
 */
export function parseCvarReply(raw: string): string | undefined {
  const value = CVAR_REPLY.exec(raw)?.[1];
  return value === undefined ? undefined : stripColorCodes(value);
}

/** What the live server's `getstatus` says, to compare against a log's latest `InitGame` line. */
interface LiveServerInfo {
  hostname: string;
  mapName: string;
  gametype: string;
}

/**
 * - `current`: same server name, map and game mode as the live server.
 * - `same-name`: same server name, but it's on another map now (an old copy, or a log that isn't
 *   being written any more).
 * - `other-server`: a game log, but of a different server.
 * - `not-a-log`: readable, with no `InitGame` line.
 * - `unreadable`: the bot's user has no read access.
 * - `missing`: no such file.
 */
export type LogFileVerdict =
  | 'current'
  | 'same-name'
  | 'other-server'
  | 'not-a-log'
  | 'unreadable'
  | 'missing';

export async function inspectLogFile(
  path: string,
  live: LiveServerInfo,
  decode?: (bytes: Buffer) => string,
): Promise<LogFileVerdict> {
  try {
    await access(path, constants.R_OK);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
  const lines = await readFileTail(path, VERIFY_TAIL_BYTES, decode);
  const initGame = lines.filter((line) => line.includes('InitGame: ')).at(-1);
  if (!initGame) {
    return 'not-a-log';
  }
  const block = initGame.slice(initGame.indexOf('InitGame: ') + 'InitGame: '.length);
  const cvars = parseCvarBlock(block);
  if (!live.hostname || cvars['sv_hostname']?.trim() !== live.hostname) {
    return 'other-server';
  }
  return cvars['mapname'] === live.mapName &&
    cvars['g_gametype'] === live.gametype
    ? 'current'
    : 'same-name';
}

export async function readLiveServerInfo(
  rcon: RconClient,
): Promise<LiveServerInfo> {
  const { cvars } = await rcon.getStatus();
  return {
    hostname: cvars['sv_hostname']?.trim() ?? '',
    mapName: cvars['mapname'] ?? '',
    gametype: cvars['g_gametype'] ?? '',
  };
}

/** Breadth-first, so a size or time limit cuts off the deepest folders rather than whole drives. */
async function searchDisk(
  root: string,
  fileNames: ReadonlySet<string>,
  limits: { maxDirs: number; maxMs: number },
): Promise<{ found: string[]; complete: boolean }> {
  const found: string[] = [];
  const deadline = Date.now() + limits.maxMs;
  let level = [root];
  let visited = 0;

  for (let depth = 0; depth <= MAX_DIR_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      if (visited >= limits.maxDirs || Date.now() > deadline) {
        return { found, complete: false };
      }
      visited += 1;
      const entries = await readdir(dir, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        const path = join(dir, entry.name);
        // Symlinks are left alone: they can loop, and they'd list one log under several paths.
        if (entry.isDirectory()) {
          if (!SKIPPED_PATHS.has(path) && !SKIPPED_DIR_NAMES.has(entry.name)) {
            next.push(path);
          }
        } else if (entry.isFile() && fileNames.has(entry.name)) {
          found.push(path);
        }
      }
    }
    level = next;
  }
  return { found, complete: level.length === 0 };
}

export interface GameLogSearchResult {
  /** The one file to use: the only log that matches the live server exactly. */
  log: string | undefined;
  /** Logs that could be this server's, when there isn't exactly one exact match. */
  possible: string[];
  /** Files that may be it, but that the bot's user can't read. */
  unreadable: string[];
  /** Where the server says it writes its log. In Docker, that's a path inside its container. */
  reportedPath: string | undefined;
  /** The server has `g_log` set to nothing, so it doesn't write a log at all. */
  loggingOff: boolean;
  /** `false` if the search hit a limit before covering the disk. */
  complete: boolean;
}

export interface FindGameLogOptions {
  decode?: (bytes: Buffer) => string;
  /** Where the disk search starts. Tests point this at a temp folder. */
  root?: string;
  maxDirs?: number;
  maxMs?: number;
}

/**
 * Finds the `games_mp.log` of the server behind `rcon`, on the machine the bot runs on. First
 * tries where the server says it writes it (`fs_homepath`, `fs_game`, `g_log`), then searches the
 * disk — the only way to find it when the game runs in Docker and the log is mounted elsewhere.
 *
 * Only content decides which file it is: its latest `InitGame` line has to name the live server,
 * map and mode. So nothing the server reports can make the bot follow a file that isn't a game log.
 */
export async function findGameLog(
  rcon: RconClient,
  options: FindGameLogOptions = {},
): Promise<GameLogSearchResult> {
  const live = await readLiveServerInfo(rcon);
  const readCvar = async (name: string) =>
    parseCvarReply(await rcon.rcon(name));
  const homePath = await readCvar('fs_homepath');
  const basePath = await readCvar('fs_basepath');
  const gameDir = (await readCvar('fs_game')) || 'main';
  const logCvar = await readCvar('g_log');

  const logName = logCvar || DEFAULT_LOG_NAME;
  const reportedPaths = [homePath, basePath]
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => join(dir, gameDir, logName));

  const { found, complete } = await searchDisk(
    options.root ?? '/',
    new Set([DEFAULT_LOG_NAME, basename(logName)]),
    {
      maxDirs: options.maxDirs ?? MAX_DIRS,
      maxMs: options.maxMs ?? MAX_SEARCH_MS,
    },
  );

  const candidates = new Set<string>();
  for (const path of [...reportedPaths, ...found]) {
    const exists = await stat(path).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code === 'EACCES',
    );
    if (exists) {
      // An unreadable parent folder makes realpath fail too; keep that path as it was reported.
      candidates.add(await realpath(path).catch(() => path));
    }
  }

  const current: string[] = [];
  const sameName: string[] = [];
  const unreadable: string[] = [];
  for (const path of candidates) {
    const verdict = await inspectLogFile(path, live, options.decode);
    if (verdict === 'current') {
      current.push(path);
    } else if (verdict === 'same-name') {
      sameName.push(path);
    } else if (verdict === 'unreadable') {
      unreadable.push(path);
    }
  }

  return {
    log: current.length === 1 ? current[0] : undefined,
    possible: current.length > 1 ? current : current.length === 0 ? sameName : [],
    unreadable,
    reportedPath: reportedPaths[0],
    loggingOff: logCvar === '',
    complete,
  };
}
