import type { RconClient } from '@cod2admin/rcon-client';
import type { GatewayDeps } from '../lib/deps.js';
import type { StatusResponse } from './api-types.js';
import { ChatFeed } from './chat-feed.js';
import { toPlayerDto } from './dto.js';
import { StatusWatcher } from './status-watcher.js';

/** Per-user cap on actions that reach a game server or the database (docs/PLAN-miniapp.md §8). */
export const ACTION_LIMIT = { max: 20, windowMs: 10_000 };

/**
 * A fixed-window counter per Telegram user — on top of rcon-client's own outgoing-packet limiter,
 * so a double-tapping or buggy client gets told to slow down instead of queueing a pile of RCON
 * commands.
 */
export class ActionLimiter {
  private readonly windows = new Map<
    number,
    { start: number; count: number }
  >();

  constructor(
    private readonly limit = ACTION_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one action; `false` once the user is over the limit for the current window. */
  take(telegramId: number): boolean {
    const now = this.now();
    const window = this.windows.get(telegramId);
    if (!window || now - window.start >= this.limit.windowMs) {
      this.windows.set(telegramId, { start: now, count: 1 });
      return true;
    }
    window.count++;
    return window.count <= this.limit.max;
  }
}

/**
 * What the Mini App keeps while the bot runs: one chat feed and one status watcher per server,
 * made on first use — servers come and go with `/addserver`/`/removeserver`.
 */
export class MiniAppState {
  private readonly chatFeeds = new Map<string, ChatFeed>();
  private readonly statusWatchers = new Map<string, StatusWatcher>();
  readonly limiter = new ActionLimiter();

  constructor(private readonly deps: GatewayDeps) {}

  rcon(alias: string): RconClient | undefined {
    return this.deps.rconClients.get(alias);
  }

  /** `undefined` when the bot doesn't read this server's log — an RCON-only install has no chat. */
  chatFeed(alias: string): ChatFeed | undefined {
    let feed = this.chatFeeds.get(alias);
    const tailer = this.deps.logTailers.get(alias);
    if (!feed && tailer) {
      feed = new ChatFeed(tailer);
      this.chatFeeds.set(alias, feed);
    }
    return feed;
  }

  statusWatcher(alias: string): StatusWatcher {
    let watcher = this.statusWatchers.get(alias);
    if (!watcher) {
      watcher = new StatusWatcher(() => this.fetchStatus(alias));
      this.statusWatchers.set(alias, watcher);
    }
    return watcher;
  }

  async fetchStatus(alias: string): Promise<StatusResponse> {
    const rcon = this.rcon(alias);
    if (!rcon) {
      throw new Error(`Server "${alias}" is no longer configured.`);
    }
    const status = await rcon.status();
    return {
      server: alias,
      hostname: status.hostname ?? null,
      mapName: status.mapName ?? null,
      players: status.players.map((player) => toPlayerDto(player, this.deps)),
      fetchedAt: new Date().toISOString(),
    };
  }
}
