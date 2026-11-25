import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadReleaseAsset,
  runApplyUpdate,
  verifyChecksum,
  type ApplyUpdateProblem,
  type DownloadProgress,
} from './update-apply.js';

describe('runApplyUpdate', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cod2admin-apply-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs a real script through `sh`, standing in for `sudo`. */
  const run = async (script: string, timeoutMs?: number) => {
    const scriptPath = join(dir, 'script.sh');
    await writeFile(scriptPath, script);
    const problems: ApplyUpdateProblem[] = [];
    runApplyUpdate(scriptPath, join(dir, 'gateway.tar.gz'), {
      command: 'sh',
      timeoutMs,
      onProblem: (problem) => problems.push(problem),
    });
    return problems;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('reports a failed script with the end of its output', async () => {
    const problems = await run(
      'echo "sudo: a password is required" >&2; exit 1',
    );

    await vi.waitFor(() => expect(problems).toHaveLength(1));
    expect(problems[0]).toEqual({
      kind: 'failed',
      output: 'sudo: a password is required',
    });
  });

  it('keeps secrets from the bot log out of the report', async () => {
    const problems = await run(
      'echo "/claim secret: abc123"; echo "boom"; exit 1',
    );

    await vi.waitFor(() => expect(problems).toHaveLength(1));
    expect(problems[0]).toEqual({ kind: 'failed', output: 'boom' });
  });

  it('reports nothing when the script succeeds', async () => {
    const problems = await run('exit 0', 50);

    await settle();
    expect(problems).toEqual([]);
  });

  it("doesn't call a script killed by a signal failed: that's the service restart", async () => {
    const problems = await run('kill -TERM $$', 50);

    await settle();
    expect(problems).toEqual([{ kind: 'timeout' }]);
  });

  it('reports a script that never finishes', async () => {
    const problems = await run('sleep 1', 30);

    await vi.waitFor(() => expect(problems).toEqual([{ kind: 'timeout' }]));
  });

  it('reports sudo not being installed instead of crashing the bot', async () => {
    await writeFile(join(dir, 'script.sh'), '');
    const problems: ApplyUpdateProblem[] = [];

    runApplyUpdate(join(dir, 'script.sh'), join(dir, 'gateway.tar.gz'), {
      command: 'no-such-command-cod2admin',
      onProblem: (problem) => problems.push(problem),
    });

    await vi.waitFor(() => expect(problems).toHaveLength(1));
    expect(problems[0]).toMatchObject({
      kind: 'failed',
      output: expect.stringContaining('ENOENT'),
    });
  });
});

function fakeFetch(body: Uint8Array, ok = true, status = 200): typeof fetch {
  return vi.fn(async () =>
    ok
      ? new Response(body, { status })
      : new Response('', { status, statusText: 'Error' }),
  ) as unknown as typeof fetch;
}

/** A response whose body sends `first`, then goes quiet (never ends) until aborted. */
function stalledResponse(first: Uint8Array, signal?: AbortSignal | null) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
      signal?.addEventListener('abort', () =>
        controller.error(signal.reason ?? new Error('aborted')),
      );
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-length': '100' },
  });
}

describe('downloadReleaseAsset', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cod2admin-update-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fast = { retryDelayMs: 1, idleMs: 50 };

  it('writes the fetched bytes to destPath and leaves no partial file', async () => {
    const dest = join(dir, 'asset.tar.gz');
    await downloadReleaseAsset(
      'https://example.com/asset.tar.gz',
      dest,
      fakeFetch(Buffer.from('hello world')),
      fast,
    );
    expect((await readFile(dest)).toString()).toBe('hello world');
    expect(await readdir(dir)).toEqual(['asset.tar.gz']);
  });

  it('throws when the response is not ok', async () => {
    const dest = join(dir, 'asset.tar.gz');
    await expect(
      downloadReleaseAsset(
        'https://example.com/asset.tar.gz',
        dest,
        fakeFetch(Buffer.from(''), false, 404),
        fast,
      ),
    ).rejects.toThrow(/404/);
  });

  it('does not retry a 404, but does retry a 503', async () => {
    const dest = join(dir, 'asset.tar.gz');
    const missing = fakeFetch(Buffer.from(''), false, 404);
    await expect(
      downloadReleaseAsset('https://x/a', dest, missing, fast),
    ).rejects.toThrow();
    expect(missing).toHaveBeenCalledTimes(1);

    let calls = 0;
    const flaky = vi.fn(async () =>
      ++calls < 3
        ? new Response('', { status: 503, statusText: 'Unavailable' })
        : new Response('ok-bytes'),
    ) as unknown as typeof fetch;
    await downloadReleaseAsset('https://x/a', dest, flaky, fast);
    expect((await readFile(dest)).toString()).toBe('ok-bytes');
  });

  it('resumes with a Range request after a stall instead of starting over', async () => {
    const dest = join(dir, 'asset.tar.gz');
    const first = Buffer.alloc(40, 'a');
    const rest = Buffer.alloc(60, 'b');
    const seen: Array<string | undefined> = [];
    let calls = 0;
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.Range);
      return ++calls === 1
        ? stalledResponse(first, init?.signal)
        : new Response(rest, { status: 206 });
    }) as unknown as typeof fetch;

    await downloadReleaseAsset('https://x/a', dest, fetchFn, fast);

    expect(seen).toEqual([undefined, 'bytes=40-']);
    expect(await readFile(dest)).toEqual(Buffer.concat([first, rest]));
  });

  it('starts again when the server ignores Range', async () => {
    const dest = join(dir, 'asset.tar.gz');
    let calls = 0;
    const whole = Buffer.alloc(100, 'c');
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) =>
      ++calls === 1
        ? stalledResponse(Buffer.alloc(30, 'x'), init?.signal)
        : new Response(whole, { status: 200 }),
    ) as unknown as typeof fetch;
    await downloadReleaseAsset('https://x/a', dest, fetchFn, fast);
    expect(await readFile(dest)).toEqual(whole);
  });

  it('gives up after the attempts, says why, and leaves nothing behind', async () => {
    const dest = join(dir, 'asset.tar.gz');
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) =>
      stalledResponse(Buffer.alloc(10, 'z'), init?.signal),
    ) as unknown as typeof fetch;
    await expect(
      downloadReleaseAsset('https://x/a', dest, fetchFn, {
        ...fast,
        attempts: 3,
      }),
    ).rejects.toThrow(/no data for .*slow or unstable/s);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(await readdir(dir)).toEqual([]);
  });

  it('reports progress, the whole size on a resume too, and the retry', async () => {
    const dest = join(dir, 'asset.tar.gz');
    const seen: DownloadProgress[] = [];
    let calls = 0;
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) =>
      ++calls === 1
        ? stalledResponse(Buffer.alloc(40, 'a'), init?.signal)
        : new Response(Buffer.alloc(60, 'b'), {
            status: 206,
            headers: { 'content-range': 'bytes 40-99/100' },
          }),
    ) as unknown as typeof fetch;

    await downloadReleaseAsset('https://x/a', dest, fetchFn, {
      ...fast,
      onProgress: (progress) => seen.push(progress),
    });

    expect(seen[0]).toMatchObject({ received: 40, total: 100, attempt: 1 });
    expect(
      seen.some((p) => p.retrying && p.attempt === 1 && p.total === 100),
    ).toBe(true);
    expect(seen.at(-1)).toMatchObject({
      received: 100,
      total: 100,
      attempt: 2,
      retrying: false,
    });
  });

  it('takes longer than a minute in total as long as data keeps coming', async () => {
    const dest = join(dir, 'asset.tar.gz');
    const chunks = 6;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < chunks; i++) {
          controller.enqueue(Buffer.alloc(10, 'd'));
          await new Promise((r) => setTimeout(r, 30));
        }
        controller.close();
      },
    });
    const fetchFn = vi.fn(
      async () => new Response(body),
    ) as unknown as typeof fetch;
    // 6 * 30 ms is longer than idleMs (50) in total, but no single pause is.
    await downloadReleaseAsset('https://x/a', dest, fetchFn, fast);
    expect((await readFile(dest)).length).toBe(60);
  });
});

describe('verifyChecksum', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cod2admin-update-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns true when the file matches a sha256sum-format checksum file', async () => {
    const filePath = join(dir, 'cod2admin-gateway-0.0.5.tar.gz');
    await writeFile(filePath, 'fake tarball contents');
    const hash = createHash('sha256')
      .update('fake tarball contents')
      .digest('hex');
    const sha256Path = join(dir, 'cod2admin-gateway-0.0.5.tar.gz.sha256');
    await writeFile(sha256Path, `${hash}  cod2admin-gateway-0.0.5.tar.gz\n`);

    await expect(verifyChecksum(filePath, sha256Path)).resolves.toBe(true);
  });

  it('returns false when the file does not match', async () => {
    const filePath = join(dir, 'cod2admin-gateway-0.0.5.tar.gz');
    await writeFile(filePath, 'tampered contents');
    const sha256Path = join(dir, 'cod2admin-gateway-0.0.5.tar.gz.sha256');
    await writeFile(
      sha256Path,
      `${'0'.repeat(64)}  cod2admin-gateway-0.0.5.tar.gz\n`,
    );

    await expect(verifyChecksum(filePath, sha256Path)).resolves.toBe(false);
  });

  it('returns false when the checksum file is empty/unparseable', async () => {
    const filePath = join(dir, 'a.tar.gz');
    await writeFile(filePath, 'x');
    const sha256Path = join(dir, 'a.tar.gz.sha256');
    await writeFile(sha256Path, '');

    await expect(verifyChecksum(filePath, sha256Path)).resolves.toBe(false);
  });
});
