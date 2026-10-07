import { RateLimiter } from './rate-limiter.js';
import {
  parseCvarBlock,
  parseInstalledMaps,
  parseMapRotation,
  parseOobPlayerLine,
  parseRconStatusTable,
} from './status-parser.js';
import type { TextEncoding } from './text-encoding.js';
import type {
  CvarMap,
  OobStatusPlayer,
  RconClientOptions,
  ServerStatus,
} from './types.js';
import { sendOobQuery, UdpQueryTimeoutError } from './udp-transport.js';

// Short attempts, many retries — a real busy server drops ~50% of queries in bursts of up to ~5s
// while replying in ~50ms otherwise (docs/PLAN.md §2.4, "Rate limiting"), so a long per-attempt
// wait only wastes time. Worst case before giving up: 8 × 1000ms + 7 × 300ms ≈ 10s.
const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_RETRIES = 7;
const DEFAULT_RETRY_DELAY_MS = 300;
const DEFAULT_MULTI_PACKET_WAIT_MS = 150;
const DEFAULT_MIN_SEND_INTERVAL_MS = 100;
// `map` gets one longer attempt instead of retries - see `map()`.
const DEFAULT_MAP_REPLY_TIMEOUT_MS = 3000;
const KICK_FAILURE_PATTERN = /^Usage:|is not on the server/i;

/**
 * Pure TS client for the Quake3/CoD out-of-band UDP RCON protocol (docs/PLAN.md §2.4/§3.1).
 * No game-specific knowledge beyond parsing `status`/`players` output.
 */
export class RconClient {
  private readonly host: string;
  private readonly port: number;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly multiPacketWaitMs: number;
  private readonly encoding: TextEncoding;
  private readonly rateLimiter: RateLimiter;
  private readonly mapReplyTimeoutMs: number;

  constructor(options: RconClientOptions) {
    this.host = options.host;
    this.port = options.port;
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.multiPacketWaitMs =
      options.multiPacketWaitMs ?? DEFAULT_MULTI_PACKET_WAIT_MS;
    this.encoding = options.encoding ?? 'latin1';
    this.rateLimiter = new RateLimiter(
      options.minSendIntervalMs ?? DEFAULT_MIN_SEND_INTERVAL_MS,
    );
    this.mapReplyTimeoutMs =
      options.mapReplyTimeoutMs ?? DEFAULT_MAP_REPLY_TIMEOUT_MS;
  }

  /** Public OOB query — cvars only, no password required, no player IPs. */
  async getInfo(): Promise<CvarMap> {
    const { header, body } = await this.query('getinfo');
    if (header !== 'infoResponse') {
      throw new Error(`Unexpected response header for getinfo: "${header}"`);
    }
    return parseCvarBlock(body.split('\n')[0] ?? '');
  }

  /** Public OOB query — cvars + a minimal player list (score/ping/name, no IP). */
  async getStatus(): Promise<{ cvars: CvarMap; players: OobStatusPlayer[] }> {
    const { header, body } = await this.query('getstatus');
    if (header !== 'statusResponse') {
      throw new Error(`Unexpected response header for getstatus: "${header}"`);
    }
    const lines = body.split('\n');
    const cvars = parseCvarBlock(lines[0] ?? '');
    const players = lines
      .slice(1)
      .map(parseOobPlayerLine)
      .filter((player): player is OobStatusPlayer => player !== null);
    return { cvars, players };
  }

  /** Sends a raw rcon command and returns the server's raw `print` response text. */
  async rcon(command: string): Promise<string> {
    const { header, body } = await this.query(
      `rcon ${this.password} ${command}`,
    );
    if (header !== 'print') {
      throw new Error(
        `Unexpected response header for rcon "${command}": "${header}"`,
      );
    }
    return body;
  }

  /** Detailed status/player table via `rcon status` — includes IPs, unlike getStatus(). */
  async status(): Promise<ServerStatus> {
    const raw = await this.rcon('status');
    return parseRconStatusTable(raw);
  }

  /**
   * Confirmed empirically against a real server: its `kick` console command tokenizes plain
   * ASCII names unquoted, but a name containing non-ASCII bytes (e.g. Cyrillic) only resolves
   * when quoted — the opposite quoting fails a *different* way for each case (a generic "Usage:"
   * message for non-ASCII unquoted, "is not on the server" for ASCII quoted), so rather than
   * guess from the name's content, retry with the other quoting style if the first attempt's
   * response looks like one of those known failure shapes.
   */
  async kick(clientIdOrName: string | number): Promise<string> {
    const result = await this.rcon(`kick ${clientIdOrName}`);
    if (
      typeof clientIdOrName === 'string' &&
      KICK_FAILURE_PATTERN.test(result)
    ) {
      return this.rcon(`kick "${clientIdOrName}"`);
    }
    return result;
  }

  /**
   * Bans the client in slot `clientId` by GUID: the game writes `<guid> <name>` to `ban.txt` and
   * drops the client. When it can't, it replies with why and the client stays connected:
   * `Client N is not active`, `This GUID (N) is already banned`, or for a GUID-0 client
   * `Can't ban user, GUID is 0` — see docs/PLAN.md §2.4/§5.7 for the IP fallback callers apply
   * then. There's deliberately no `banUser`: it takes a player *name*, like `kick`, and a slot
   * number sent to it fails with "Player N is not on the server" (confirmed live, §2.4 "ban.txt").
   */
  async banClient(clientId: number): Promise<string> {
    return this.rcon(`banClient ${clientId}`);
  }

  /**
   * Removes every `ban.txt` line for a player **name** and returns how many were removed. The game
   * matches on the name, not the GUID: `unbanUser <guid>` replies "no banned user has name <guid>"
   * (confirmed live, docs/PLAN.md §2.4 "ban.txt"). Always quoted, which works for plain, spaced
   * and color-coded names. Throws on any other reply rather than guess it succeeded.
   */
  async unbanUser(name: string): Promise<number> {
    const result = await this.rcon(`unbanUser "${name.replace(/"/g, '')}"`);
    const removed = /unbanned (\d+) user/i.exec(result);
    if (removed) {
      return Number(removed[1]);
    }
    if (/no banned user has name/i.test(result)) {
      return 0;
    }
    throw new Error(`Unexpected unbanUser reply: "${result.trim()}"`);
  }

  /**
   * Always quoted: the server's command parser treats every byte above 0x7F as whitespace outside
   * quotes, so unquoted Cyrillic (CP1251) text was dropped and `say Вика вас всех забанит!` showed
   * players only "!" (docs/PLAN.md §2.4, "Text encoding"). A `"` in the message would end the
   * quoted string early, so it's removed.
   */
  async say(message: string): Promise<string> {
    return this.rcon(`say "${message.replace(/"/g, '')}"`);
  }

  /**
   * A private message to the player in slot `clientId` — the server console's `tell`. Quoted for
   * the same reason as `say`: unquoted CP1251 text would be dropped.
   */
  async tell(clientId: number, message: string): Promise<string> {
    return this.rcon(`tell ${clientId} "${message.replace(/"/g, '')}"`);
  }

  /**
   * Sent **once**, never retried. The server runs `map` and then loads the level before it gets to
   * its reply, which often doesn't come at all — a retry then starts the load over (seen live on
   * the dev server 2026-10-07: one Mini App map switch reloaded the map three times and still ended
   * in a timeout). So a missing reply is checked instead: `getinfo` (retried as usual, which also
   * waits out the load) says whether the server is on the requested map now. Only if it isn't does
   * this throw the original timeout.
   */
  async map(mapName: string): Promise<string> {
    try {
      const { header, body } = await this.query(
        `rcon ${this.password} map ${mapName}`,
        { retries: 0, timeoutMs: this.mapReplyTimeoutMs },
      );
      if (header !== 'print') {
        throw new Error(
          `Unexpected response header for rcon "map ${mapName}": "${header}"`,
        );
      }
      return body;
    } catch (error) {
      if (!(error instanceof UdpQueryTimeoutError)) {
        throw error;
      }
      const info = await this.getInfo();
      if (info['mapname']?.toLowerCase() === mapName.toLowerCase()) {
        return '';
      }
      throw error;
    }
  }

  /** Map names configured in `sv_mapRotation`, in rotation order — see `parseMapRotation` for why. */
  async getMapRotation(): Promise<string[]> {
    return parseMapRotation(await this.rcon('sv_mapRotation'));
  }

  /** Every map the server can load (stock and custom), sorted — see `parseInstalledMaps`. */
  async getInstalledMaps(): Promise<string[]> {
    return parseInstalledMaps(await this.rcon('dir maps/mp d3dbsp'));
  }

  private async query(
    payload: string,
    overrides: { retries?: number; timeoutMs?: number } = {},
  ) {
    return sendOobQuery(payload, {
      host: this.host,
      port: this.port,
      timeoutMs: overrides.timeoutMs ?? this.timeoutMs,
      retries: overrides.retries ?? this.retries,
      retryDelayMs: this.retryDelayMs,
      multiPacketWaitMs: this.multiPacketWaitMs,
      beforeAttempt: () => this.rateLimiter.wait(),
      encoding: this.encoding,
    });
  }
}
