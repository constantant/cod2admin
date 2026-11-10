import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadReleaseAsset,
  runApplyUpdate,
  verifyChecksum,
  type ApplyUpdateProblem,
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
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    arrayBuffer: () =>
      Promise.resolve(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      ),
  }) as unknown as typeof fetch;
}

describe('downloadReleaseAsset', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cod2admin-update-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the fetched bytes to destPath', async () => {
    const dest = join(dir, 'asset.tar.gz');
    await downloadReleaseAsset(
      'https://example.com/asset.tar.gz',
      dest,
      fakeFetch(Buffer.from('hello world')),
    );
    expect((await readFile(dest)).toString()).toBe('hello world');
  });

  it('throws when the response is not ok', async () => {
    const dest = join(dir, 'asset.tar.gz');
    await expect(
      downloadReleaseAsset(
        'https://example.com/asset.tar.gz',
        dest,
        fakeFetch(Buffer.from(''), false, 404),
      ),
    ).rejects.toThrow(/404/);
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
