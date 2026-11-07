import type { ServerConfig } from '@cod2admin/admin-store';
import {
  stripColorCodes,
  type RconClient,
  type StatusPlayer,
} from '@cod2admin/rcon-client';
import type { GatewayDeps } from '../lib/deps.js';
import type { PlayerDto, StatusResponse } from './api-types.js';
import type { ChatFeed } from './chat-feed.js';
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

/** How much of the note list the live player marks look at — far more than any server has. */
const MAX_INDEXED_NOTES = 5000;

/** What notes are filed under for a name: lower case, no colour codes. */
export function noteNameKey(name: string): string {
  return stripColorCodes(name).trim().toLowerCase();
}

/** Things only `main.ts` has — the bot and the text encoding. Absent in tests that don't need them. */
export interface MiniAppIntegrations {
  /** Starts reading a server's log (`startReportTailer`). */
  startTailer?(server: ServerConfig): void;
  decode?(bytes: Buffer): string;
  /** Closes a report's Telegram card, if it has one. */
  closeReportCard?(reportId: number, text: string): Promise<void>;
}

/**
 * What the Mini App keeps while the bot runs: one chat feed and one status watcher per server,
 * made on first use — servers come and go with `/addserver`/`/removeserver`.
 */
export class MiniAppState {
  private readonly statusWatchers = new Map<string, StatusWatcher>();
  readonly limiter = new ActionLimiter();
  /** Why the last update from the app failed, until the next try. */
  updateProblem: string | null = null;
  /** `kind:value` → on the watchlist, for marking players live. Reloaded after any note change. */
  private noteIndex: Promise<Map<string, boolean>> | undefined;

  constructor(
    private readonly deps: GatewayDeps,
    readonly integrations: MiniAppIntegrations = {},
  ) {}

  invalidateNotes(): void {
    this.noteIndex = undefined;
  }

  private notes(): Promise<Map<string, boolean>> {
    this.noteIndex ??= this.deps.adminStore
      .searchPlayerNotes({ limit: MAX_INDEXED_NOTES })
      .then((notes) => {
        const index = new Map<string, boolean>();
        for (const { kind, value, watch } of notes) {
          const key = `${kind}:${value}`;
          index.set(key, watch || index.get(key) === true);
        }
        return index;
      })
      .catch((error: unknown) => {
        // Marks are a convenience: the player list must not fail over them.
        console.error('Mini App: loading player notes failed:', error);
        this.noteIndex = undefined;
        return new Map<string, boolean>();
      });
    return this.noteIndex;
  }

  private noteMarks(
    player: StatusPlayer,
    index: Map<string, boolean>,
  ): { noted?: true; watched?: true } {
    const keys = [`name:${noteNameKey(player.name)}`];
    if (player.guid && player.guid !== '0') {
      keys.push(`guid:${player.guid}`);
    }
    if (player.ip) {
      keys.push(`ip:${player.ip}`);
    }
    const found = keys.filter((key) => index.has(key));
    if (found.length === 0) {
      return {};
    }
    return {
      noted: true,
      ...(found.some((key) => index.get(key)) ? { watched: true } : {}),
    };
  }

  rcon(alias: string): RconClient | undefined {
    return this.deps.rconClients.get(alias);
  }

  /** `undefined` when the bot doesn't read this server's log — an RCON-only install has no chat. */
  chatFeed(alias: string): ChatFeed | undefined {
    return this.deps.chatFeeds.get(alias);
  }

  statusWatcher(alias: string): StatusWatcher {
    let watcher = this.statusWatchers.get(alias);
    if (!watcher) {
      watcher = new StatusWatcher(() => this.fetchStatus(alias));
      this.statusWatchers.set(alias, watcher);
    }
    return watcher;
  }

  /** Players as the app shows them: IP details, plus the marks from notes and the watchlist. */
  async playerDtos(players: readonly StatusPlayer[]): Promise<PlayerDto[]> {
    const notes = await this.notes();
    return players.map((player) => ({
      ...toPlayerDto(player, this.deps),
      ...this.noteMarks(player, notes),
    }));
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
      players: await this.playerDtos(status.players),
      fetchedAt: new Date().toISOString(),
    };
  }
}
