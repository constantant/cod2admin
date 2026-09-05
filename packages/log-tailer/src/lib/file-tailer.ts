import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface FileTailerOptions {
  path: string;
  onLine: (line: string) => void;
  onError?: (error: Error) => void;
  pollIntervalMs?: number;
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
  private position = 0;
  private buffered = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(options: FileTailerOptions) {
    this.path = options.path;
    this.onLine = options.onLine;
    this.onError = options.onError ?? (() => {});
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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
      const stream = createReadStream(this.path, { start, end: end - 1, encoding: 'utf8' });
      let text = '';
      stream.on('data', (chunk) => {
        text += chunk;
      });
      stream.on('end', () => resolve(text));
      stream.on('error', reject);
    });
  }
}
