import { RateLimiter } from './rate-limiter.js';
import { parseCvarBlock, parseMapRotation, parseOobPlayerLine, parseRconStatusTable } from './status-parser.js';
import type { CvarMap, OobStatusPlayer, RconClientOptions, ServerStatus } from './types.js';
import { sendOobQuery } from './udp-transport.js';

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MIN_SEND_INTERVAL_MS = 100;
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
  private readonly rateLimiter: RateLimiter;

  constructor(options: RconClientOptions) {
    this.host = options.host;
    this.port = options.port;
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.rateLimiter = new RateLimiter(options.minSendIntervalMs ?? DEFAULT_MIN_SEND_INTERVAL_MS);
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
    const { header, body } = await this.query(`rcon ${this.password} ${command}`);
    if (header !== 'print') {
      throw new Error(`Unexpected response header for rcon "${command}": "${header}"`);
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
    if (typeof clientIdOrName === 'string' && KICK_FAILURE_PATTERN.test(result)) {
      return this.rcon(`kick "${clientIdOrName}"`);
    }
    return result;
  }

  /**
   * Bans a currently-connected client's GUID (written to ban.txt by the game binary).
   * GUID-0 clients are not actually banned by this — see docs/PLAN.md §2.4/§5.7 for the
   * IP-fallback path callers must apply in that case.
   */
  async banClient(clientId: number): Promise<string> {
    return this.rcon(`banClient ${clientId}`);
  }

  /** Bans by GUID, same ban.txt mechanism as banClient — see docs/PLAN.md §2.4 for caveats. */
  async banUser(clientId: number): Promise<string> {
    return this.rcon(`banUser ${clientId}`);
  }

  async unbanUser(guid: string): Promise<string> {
    return this.rcon(`unbanUser ${guid}`);
  }

  async say(message: string): Promise<string> {
    return this.rcon(`say ${message}`);
  }

  async map(mapName: string): Promise<string> {
    return this.rcon(`map ${mapName}`);
  }

  /** Map names configured in `sv_mapRotation`, in rotation order — see `parseMapRotation` for why. */
  async getMapRotation(): Promise<string[]> {
    return parseMapRotation(await this.rcon('sv_mapRotation'));
  }

  private async query(payload: string) {
    await this.rateLimiter.wait();
    return sendOobQuery(payload, {
      host: this.host,
      port: this.port,
      timeoutMs: this.timeoutMs,
      retries: this.retries,
    });
  }
}
