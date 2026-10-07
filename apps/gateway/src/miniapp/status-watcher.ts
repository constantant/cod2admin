import type { StatusResponse } from './api-types.js';

export const STATUS_POLL_INTERVAL_MS = 5_000;

export type StatusUpdate = { ok: true; status: StatusResponse } | { ok: false; message: string };

/**
 * Pushes one server's `status` to every open Mini App (docs/PLAN-miniapp.md §5, "Real-time
 * transport"). It polls only while someone is watching, and once per interval however many are —
 * so ten admins with the dashboard open cost the game server what one does (§8, rate limiting).
 * A poll still running when the next is due is skipped, not stacked: an unresponsive server makes
 * one `status` take ~10s (rcon-client's retries).
 */
export class StatusWatcher {
  private readonly listeners = new Set<(update: StatusUpdate) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private last: StatusUpdate | undefined;

  constructor(
    private readonly fetchStatus: () => Promise<StatusResponse>,
    private readonly intervalMs = STATUS_POLL_INTERVAL_MS,
  ) {}

  /** Calls `listener` with every update (the latest one right away, if any) until unsubscribed. */
  subscribe(listener: (update: StatusUpdate) => void): () => void {
    this.listeners.add(listener);
    if (this.last) {
      listener(this.last);
    }
    if (!this.timer) {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), this.intervalMs);
      this.timer.unref?.();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
        this.last = undefined;
      }
    };
  }

  get watching(): boolean {
    return this.timer !== undefined;
  }

  /** Shares a status fetched elsewhere (e.g. right after a kick) so watchers see it now. */
  publish(status: StatusResponse): void {
    if (this.timer) {
      this.emit({ ok: true, status });
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      this.emit({ ok: true, status: await this.fetchStatus() });
    } catch (error) {
      this.emit({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.polling = false;
    }
  }

  private emit(update: StatusUpdate): void {
    if (!this.timer) {
      return; // everyone left while the poll was running
    }
    this.last = update;
    for (const listener of this.listeners) {
      listener(update);
    }
  }
}
