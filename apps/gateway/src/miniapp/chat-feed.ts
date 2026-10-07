import type { ChatEvent } from '@cod2admin/log-tailer';
import type { ChatLineDto } from './api-types.js';

/** What a `ChatFeed` needs from `GameLogTailer` — an interface, so tests can pass a fake. */
export interface ChatSource {
  on(event: 'chat', listener: (chat: ChatEvent) => void): unknown;
  readRecentChat(limit: number): Promise<ChatEvent[]>;
}

export const CHAT_HISTORY_SIZE = 200;

/**
 * Removes the control bytes the CoD2 client puts in front of some messages (seen live, see
 * log-tailer's `detectReportTrigger`) — they'd show as boxes in the UI.
 */
function cleanMessage(message: string): string {
  return message.replace(/[\x00-\x1f]/g, '').trim();
}

function fromChatEvent(
  chat: ChatEvent,
  id: number,
  at: Date | null,
): ChatLineDto {
  return {
    id,
    at: at?.toISOString() ?? null,
    channel: chat.channel,
    source: 'game',
    num: chat.num,
    name: chat.name,
    message: cleanMessage(chat.message),
  };
}

/** A line plus the raw log line it came from, to spot one that's both live and in the backfill. */
interface StoredLine {
  line: ChatLineDto;
  raw?: string;
}

/**
 * One server's in-game chat for the Mini App (docs/PLAN-miniapp.md §6.2): a second subscriber to
 * the `GameLogTailer` that `!report` already uses, not a second log reader. Keeps the last
 * `CHAT_HISTORY_SIZE` lines, plus what admins send from the bot (the game doesn't log those as
 * chat).
 *
 * The first `history()` call also reads the chat already in the log, from before the bot started.
 * Those lines get negative ids, so ids stay increasing and every id a client has already seen
 * keeps meaning the same line. A line the tailer delivered that the backfill reads again (it was
 * written just before) is kept once.
 */
export class ChatFeed {
  private stored: StoredLine[] = [];
  private readonly listeners = new Set<(line: ChatLineDto) => void>();
  private nextId = 1;
  private backfill: Promise<void> | undefined;

  constructor(
    private readonly source: ChatSource,
    private readonly now: () => Date = () => new Date(),
  ) {
    source.on('chat', (chat) => {
      this.add({
        line: fromChatEvent(chat, this.nextId++, this.now()),
        raw: chat.raw,
      });
    });
  }

  /** The lines so far, oldest first — reads the log's tail on the first call. */
  async history(): Promise<ChatLineDto[]> {
    this.backfill ??= this.readBackfill();
    await this.backfill;
    return this.stored.map(({ line }) => line);
  }

  /** Records a line sent from the bot (`say`/`tell`) and pushes it to subscribers. */
  addAdminLine(line: Omit<ChatLineDto, 'id' | 'at' | 'source'>): void {
    this.add({
      line: {
        ...line,
        id: this.nextId++,
        at: this.now().toISOString(),
        source: 'admin',
      },
    });
  }

  /** Calls `listener` with every new line until the returned function is called. */
  subscribe(listener: (line: ChatLineDto) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async readBackfill(): Promise<void> {
    const recent = await this.source
      .readRecentChat(CHAT_HISTORY_SIZE)
      .catch((error: unknown) => {
        console.error(
          'Mini App: reading recent chat from the game log failed:',
          error,
        );
        return [];
      });
    const seenLive = new Set(this.stored.map(({ raw }) => raw).filter(Boolean));
    const older = recent.filter((chat) => !seenLive.has(chat.raw));
    const backfilled = older.map((chat, index) => ({
      line: fromChatEvent(chat, index - older.length, null),
      raw: chat.raw,
    }));
    this.stored = [...backfilled, ...this.stored].slice(-CHAT_HISTORY_SIZE);
  }

  private add(entry: StoredLine): void {
    this.stored.push(entry);
    if (this.stored.length > CHAT_HISTORY_SIZE) {
      this.stored.shift();
    }
    for (const listener of this.listeners) {
      listener(entry.line);
    }
  }
}
