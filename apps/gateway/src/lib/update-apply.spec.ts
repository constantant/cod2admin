import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadReleaseAsset, verifyChecksum } from './update-apply.js';

function fakeFetch(body: Uint8Array, ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
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
    await downloadReleaseAsset('https://example.com/asset.tar.gz', dest, fakeFetch(Buffer.from('hello world')));
    expect((await readFile(dest)).toString()).toBe('hello world');
  });

  it('throws when the response is not ok', async () => {
    const dest = join(dir, 'asset.tar.gz');
    await expect(
      downloadReleaseAsset('https://example.com/asset.tar.gz', dest, fakeFetch(Buffer.from(''), false, 404)),
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
    const hash = createHash('sha256').update('fake tarball contents').digest('hex');
    const sha256Path = join(dir, 'cod2admin-gateway-0.0.5.tar.gz.sha256');
    await writeFile(sha256Path, `${hash}  cod2admin-gateway-0.0.5.tar.gz\n`);

    await expect(verifyChecksum(filePath, sha256Path)).resolves.toBe(true);
  });

  it('returns false when the file does not match', async () => {
    const filePath = join(dir, 'cod2admin-gateway-0.0.5.tar.gz');
    await writeFile(filePath, 'tampered contents');
    const sha256Path = join(dir, 'cod2admin-gateway-0.0.5.tar.gz.sha256');
    await writeFile(sha256Path, `${'0'.repeat(64)}  cod2admin-gateway-0.0.5.tar.gz\n`);

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
