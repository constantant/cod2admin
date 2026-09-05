import { mkdtemp, rm, writeFile, appendFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileTailer } from './file-tailer.js';

const POLL_INTERVAL_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns true or `timeoutMs` elapses (then throws). */
async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('until(): condition never became true');
    }
    await sleep(5);
  }
}

describe('FileTailer', () => {
  let dir: string;
  let path: string;
  let tailer: FileTailer | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'log-tailer-test-'));
    path = join(dir, 'games_mp.log');
  });

  afterEach(async () => {
    tailer?.stop();
    tailer = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('only emits lines appended after start() — pre-existing content is not replayed', async () => {
    await writeFile(path, 'old line 1\nold line 2\n');
    const lines: string[] = [];
    tailer = new FileTailer({ path, onLine: (line) => lines.push(line), pollIntervalMs: POLL_INTERVAL_MS });
    await tailer.start();

    await appendFile(path, 'new line\n');
    await until(() => lines.length === 1);

    expect(lines).toEqual(['new line']);
  });

  it('buffers a partial (no trailing newline) line across polls until it completes', async () => {
    await writeFile(path, '');
    const lines: string[] = [];
    tailer = new FileTailer({ path, onLine: (line) => lines.push(line), pollIntervalMs: POLL_INTERVAL_MS });
    await tailer.start();

    await appendFile(path, 'half a');
    await sleep(POLL_INTERVAL_MS * 3); // let it poll a few times with no complete line yet
    expect(lines).toEqual([]);

    await appendFile(path, ' line\nsecond line\n');
    await until(() => lines.length === 2);

    expect(lines).toEqual(['half a line', 'second line']);
  });

  it('restarts from the top when the file is truncated (e.g. log rotation)', async () => {
    await writeFile(path, 'line 1\n');
    const lines: string[] = [];
    tailer = new FileTailer({ path, onLine: (line) => lines.push(line), pollIntervalMs: POLL_INTERVAL_MS });
    await tailer.start();

    await appendFile(path, 'line 2\n');
    await until(() => lines.length === 1);

    await truncate(path, 0);
    await writeFile(path, 'fresh line\n');
    await until(() => lines.length === 2);

    expect(lines).toEqual(['line 2', 'fresh line']);
  });

  it('strips a trailing \\r (CRLF-written file)', async () => {
    await writeFile(path, '');
    const lines: string[] = [];
    tailer = new FileTailer({ path, onLine: (line) => lines.push(line), pollIntervalMs: POLL_INTERVAL_MS });
    await tailer.start();

    await appendFile(path, 'crlf line\r\n');
    await until(() => lines.length === 1);

    expect(lines).toEqual(['crlf line']);
  });

  it('stop() prevents further polling', async () => {
    await writeFile(path, '');
    const lines: string[] = [];
    tailer = new FileTailer({ path, onLine: (line) => lines.push(line), pollIntervalMs: POLL_INTERVAL_MS });
    await tailer.start();
    tailer.stop();

    await appendFile(path, 'should not be seen\n');
    await sleep(POLL_INTERVAL_MS * 3);

    expect(lines).toEqual([]);
  });
});
