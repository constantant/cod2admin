import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface FileTailerOptions {
  path: string;
  onLine: (line: string) => void;
  onError?: (error: Error) => void;
  pollIntervalMs?: number;
  /**
   * Turns the file's raw bytes into text. Default UTF-8. The game writes `games_mp.log` in
   * whatever single-byte code page the server's players use (CP1251 on Russian servers, see
   * docs/PLAN.md §2.4, "Text encoding"), so the gateway passes the same decoder its RCON client
   * uses. Otherwise player names from the log wouldn't match the ones from `rcon status`.
   */
  decode?: (bytes: Buffer) => string;
}

/**
 * Polls a growing text file and calls `onLine` for each complete line appended since the last
 * check — a `tail -f` for files that keep being written to.
 *
 * Polling, not `fs.watch`/`fs.watchFile`: in dev (docs/PLAN.md §11.1) this file is written by a
 * process inside a Docker container into a host bind mount, and filesystem change-notification
 * delivery across that boundary is not reliable. A plain poll works the same way regardless of
 * what's writing the file or how, at the cost of up to one `pollIntervalMs` of latency — fine
 * for a `!report` bot, not fine for something needing sub-second reaction time.
 */
export class FileTailer {
  private readonly path: string;
  private readonly onLine: (line: string) => void;
  private readonly onError: (error: Error) => void;
  private readonly pollIntervalMs: number;
  private readonly decode: (bytes: Buffer) => string;
  private position = 0;
  private buffered = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(options: FileTailerOptions) {
    this.path = options.path;
    this.onLine = options.onLine;
    this.onError = options.onError ?? (() => {});
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.decode = options.decode ?? ((bytes) => bytes.toString('utf8'));
  }

  /** Starts polling from the file's current size — only lines appended after this point are emitted. */
  async start(): Promise<void> {
    const stats = await stat(this.path).catch(() => undefined);
    this.position = stats?.size ?? 0;
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      return; // previous poll still running (slow disk, large batch) - don't overlap it
    }
    this.polling = true;
    try {
      const stats = await stat(this.path).catch(() => undefined);
      if (!stats) {
        return;
      }
      if (stats.size < this.position) {
        // Truncated or replaced (e.g. log rotation) - start reading from the top again.
        this.position = 0;
        this.buffered = '';
      }
      if (stats.size === this.position) {
        return;
      }
      const chunk = await this.readRange(this.position, stats.size);
      this.position = stats.size;
      this.buffered += chunk;
      const lines = this.buffered.split('\n');
      this.buffered = lines.pop() ?? ''; // keep a trailing partial line for the next poll
      for (const line of lines) {
        this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      }
    } catch (error) {
      this.onError(error as Error);
    } finally {
      this.polling = false;
    }
  }

  private readRange(start: number, end: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(this.path, { start, end: end - 1 });
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => {
        chunks.push(chunk as Buffer);
      });
      stream.on('end', () => resolve(this.decode(Buffer.concat(chunks))));
      stream.on('error', reject);
    });
  }
}

/**
 * The complete lines in the last `maxBytes` of a file, oldest first — for showing recent history
 * before `FileTailer` takes over (the Mini App's chat backfill, docs/PLAN-miniapp.md §6.2). A
 * missing file reads as no lines. When the read starts mid-file, the first (partial) line is
 * dropped.
 */
export async function readFileTail(
  path: string,
  maxBytes: number,
  decode: (bytes: Buffer) => string = (bytes) => bytes.toString('utf8'),
): Promise<string[]> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = decode(buffer).split('\n');
    if (start > 0) {
      lines.shift();
    }
    if (lines.at(-1) === '') {
      lines.pop();
    }
    return lines.map((line) =>
      line.endsWith('\r') ? line.slice(0, -1) : line,
    );
  } finally {
    await handle.close();
  }
}
