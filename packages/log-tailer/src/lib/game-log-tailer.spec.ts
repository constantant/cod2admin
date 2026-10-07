import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameLogTailer } from './game-log-tailer.js';
import type { PlayerSession, ReportTrigger } from './types.js';

const POLL_INTERVAL_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('until(): condition never became true');
    }
    await sleep(5);
  }
}

describe('GameLogTailer', () => {
  let dir: string;
  let path: string;
  let tailer: GameLogTailer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'game-log-tailer-test-'));
    path = join(dir, 'games_mp.log');
    await writeFile(path, '');
  });

  afterEach(async () => {
    tailer?.stop();
    tailer = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('tracks connect -> chat -> !report -> disconnect end to end from real appended log lines', async () => {
    tailer = new GameLogTailer({ logPath: path, pollIntervalMs: POLL_INTERVAL_MS });
    const connects: PlayerSession[] = [];
    const disconnects: PlayerSession[] = [];
    const triggers: ReportTrigger[] = [];
    tailer.on('connect', (session) => connects.push(session));
    tailer.on('disconnect', (session) => disconnects.push(session));
    tailer.on('reportTrigger', (trigger) => triggers.push(trigger));
    await tailer.start();

    await appendFile(
      path,
      [
        '10:00 J;0;0;WOWOWOW',
        '10:05 say;0;0;WOWOWOW;hi all',
        '10:10 say;0;0;WOWOWOW;!report Cheatr123 aimbot',
        '10:15 Q;0;0;WOWOWOW',
        '',
      ].join('\n'),
    );

    await until(() => triggers.length === 1 && disconnects.length === 1);

    expect(connects).toHaveLength(1);
    expect(connects[0]).toMatchObject({ num: 0, name: 'WOWOWOW' });

    expect(triggers[0].targetName).toBe('Cheatr123');
    expect(triggers[0].reason).toBe('aimbot');

    expect(disconnects[0].disconnectedAt).toBeDefined();

    // The connect event object is the same session that keeps being updated in place.
    const session = tailer.getSession(0)!;
    expect(session.disconnectedAt).toBeDefined();
    expect(session.chatHistory.map((c) => c.message)).toEqual(['hi all', '!report Cheatr123 aimbot']);
    expect(tailer.listSessions()).toEqual([session]);
  });

  it('does not replay pre-existing log content written before start()', async () => {
    await writeFile(path, '1:00 J;0;0;Someone\n');
    tailer = new GameLogTailer({ logPath: path, pollIntervalMs: POLL_INTERVAL_MS });
    const connects: PlayerSession[] = [];
    tailer.on('connect', (session) => connects.push(session));
    await tailer.start();

    await appendFile(path, '2:00 J;0;1;NewGuy\n');
    await until(() => connects.length === 1);

    expect(connects[0].name).toBe('NewGuy');
  });

  describe('readRecentChat (Mini App chat backfill)', () => {
    it('returns the last chat lines already in the log, oldest first, skipping other events', async () => {
      await writeFile(path, '1:00 J;0;0;A\r\n1:01 say;0;0;A;one\r\n1:02 sayteam;0;0;A;two\r\n1:03 say;0;0;A;three\r\n');
      tailer = new GameLogTailer({ logPath: path });

      const chat = await tailer.readRecentChat(2);

      expect(chat.map((line) => [line.channel, line.message])).toEqual([
        ['sayteam', 'two'],
        ['say', 'three'],
      ]);
    });

    it('drops the partial first line when it only reads the end of a big file', async () => {
      await writeFile(path, '1:01 say;0;0;A;first line\n1:02 say;0;0;B;second\n');
      tailer = new GameLogTailer({ logPath: path });

      const chat = await tailer.readRecentChat(10, 30);

      expect(chat.map((line) => line.message)).toEqual(['second']);
    });

    it('reads as no chat when the log does not exist yet', async () => {
      tailer = new GameLogTailer({ logPath: join(dir, 'missing.log') });

      await expect(tailer.readRecentChat(10)).resolves.toEqual([]);
    });
  });
});
