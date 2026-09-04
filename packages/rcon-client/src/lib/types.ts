export interface RconClientOptions {
  host: string;
  port: number;
  password: string;
  /** Time to wait for a response before retrying/giving up, in ms. Default 2000. */
  timeoutMs?: number;
  /** Retries on timeout before rejecting (UDP packets can be silently dropped). Default 2. */
  retries?: number;
  /** Minimum delay enforced between outgoing packets, in ms — see §8 of docs/PLAN.md. Default 100. */
  minSendIntervalMs?: number;
}

export type CvarMap = Record<string, string>;

/** Player entry from the public OOB `getstatus` query — no IP (protocol never exposes it here). */
export interface OobStatusPlayer {
  score: number;
  ping: number;
  name: string;
}

/** Player entry from `rcon status` — includes IP, used for report enrichment (docs/PLAN.md §5.3). */
export interface StatusPlayer {
  num: number;
  score: number;
  ping: number;
  name: string;
  lastmsg?: number;
  ip?: string;
  port?: number;
  qport?: number;
  rate?: number;
}

export interface ServerStatus {
  raw: string;
  mapName?: string;
  hostname?: string;
  players: StatusPlayer[];
}
