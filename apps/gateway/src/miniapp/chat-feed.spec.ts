import type { ChatEvent } from '@cod2admin/log-tailer';
import { describe, expect, it, vi } from 'vitest';
import { ChatFeed, CHAT_HISTORY_SIZE, type ChatSource } from './chat-feed.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');

function chat(message: string, overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    channel: 'say',
    guid: '0',
    num: 3,
    name: '^1Kim',
    message,
    timestamp: { minutes: 1, seconds: 0 },
    raw: `1:00 say;0;3;^1Kim;${message}`,
    ...overrides,
  };
}

function fakeSource(recent: ChatEvent[] = []) {
  let emit: (chat: ChatEvent) => void = () => undefined;
  const source: ChatSource = {
    on: vi.fn((_event: 'chat', listener: (chat: ChatEvent) => void) => {
      emit = listener;
    }),
    readRecentChat: vi.fn(async () => recent),
  };
  return { source, emit: (event: ChatEvent) => emit(event) };
}

describe('ChatFeed', () => {
  it('starts with the chat already in the log, then adds live lines and pushes them to subscribers', async () => {
    const { source, emit } = fakeSource([chat('old one'), chat('old two')]);
    const feed = new ChatFeed(source, () => NOW);
    const pushed: unknown[] = [];
    feed.subscribe((line) => pushed.push(line));

    expect(await feed.history()).toEqual([
      expect.objectContaining({
        id: -2,
        at: null,
        message: 'old one',
        source: 'game',
        name: '^1Kim',
        num: 3,
      }),
      expect.objectContaining({ id: -1, message: 'old two' }),
    ]);

    emit(chat('live', { channel: 'sayteam' }));

    expect(pushed).toEqual([
      {
        id: 1,
        at: NOW.toISOString(),
        channel: 'sayteam',
        source: 'game',
        num: 3,
        name: '^1Kim',
        message: 'live',
      },
    ]);
    expect((await feed.history()).map((line) => line.message)).toEqual([
      'old one',
      'old two',
      'live',
    ]);
  });

  it('keeps a line once when it arrived live before the backfill read it from the file too', async () => {
    const { source, emit } = fakeSource([chat('older'), chat('both')]);
    const feed = new ChatFeed(source, () => NOW);
    emit(chat('both'));

    const history = await feed.history();

    expect(history.map((line) => [line.id, line.message])).toEqual([
      [-1, 'older'],
      [1, 'both'],
    ]);
  });

  it('strips the control bytes the game puts before some messages', async () => {
    const { source } = fakeSource([chat('\u0015!report x')]);
    const feed = new ChatFeed(source, () => NOW);

    expect((await feed.history())[0].message).toBe('!report x');
  });

  it('records admin lines and pushes them like any other', async () => {
    const { source } = fakeSource();
    const feed = new ChatFeed(source, () => NOW);
    const pushed: unknown[] = [];
    feed.subscribe((line) => pushed.push(line));

    feed.addAdminLine({
      channel: 'tell',
      num: 3,
      name: '@kim',
      message: 'stop',
      to: '^1Kim',
    });

    expect(pushed).toEqual([
      {
        id: 1,
        at: NOW.toISOString(),
        channel: 'tell',
        source: 'admin',
        num: 3,
        name: '@kim',
        message: 'stop',
        to: '^1Kim',
      },
    ]);
    expect(await feed.history()).toEqual(pushed);
  });

  it('keeps only the newest lines, and stops pushing after unsubscribing', async () => {
    const { source, emit } = fakeSource();
    const feed = new ChatFeed(source, () => NOW);
    const listener = vi.fn();
    const unsubscribe = feed.subscribe(listener);
    await feed.history();

    for (let i = 0; i < CHAT_HISTORY_SIZE + 5; i++) {
      emit(chat(`m${i}`, { raw: `r${i}` }));
    }
    unsubscribe();
    emit(chat('after'));

    // The feed keeps recording for whoever asks next; only the push stopped.
    const history = await feed.history();
    expect(history).toHaveLength(CHAT_HISTORY_SIZE);
    expect(history[0].message).toBe('m6');
    expect(history.at(-1)?.message).toBe('after');
    expect(listener).toHaveBeenCalledTimes(CHAT_HISTORY_SIZE + 5);
  });

  it('reads the log only once, and survives a failed read', async () => {
    const { source } = fakeSource();
    vi.mocked(source.readRecentChat).mockRejectedValueOnce(new Error('EACCES'));
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const feed = new ChatFeed(source, () => NOW);

    await expect(feed.history()).resolves.toEqual([]);
    await feed.history();

    expect(source.readRecentChat).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
