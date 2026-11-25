import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  BackupCryptoError,
  CHUNK_SIZE,
  decryptStream,
  encryptStream,
} from './crypto.js';

const PASS = 'correct horse battery';

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of source) out.push(chunk);
  return Buffer.concat(out);
}

const seal = (plain: Buffer) =>
  collect(encryptStream(Readable.from([plain]), PASS, 10));
const open = (data: Buffer, pass = PASS) =>
  collect(decryptStream(Readable.from([data]), pass));

describe('whole-file encryption', () => {
  it('round-trips small and multi-chunk data', async () => {
    for (const size of [0, 5, CHUNK_SIZE, CHUNK_SIZE * 2 + 17]) {
      const plain = Buffer.alloc(size, 7);
      expect((await open(await seal(plain))).equals(plain)).toBe(true);
    }
  });

  it('keeps plaintext out of the file', async () => {
    const sealed = await seal(Buffer.from('rcon_secret_value 203.0.113.9'));
    expect(sealed.includes('203.0.113.9')).toBe(false);
  });

  it('refuses a wrong passphrase', async () => {
    const sealed = await seal(Buffer.from('hello'));
    await expect(open(sealed, 'another passphrase!')).rejects.toThrow(
      BackupCryptoError,
    );
  });

  it('refuses a flipped byte', async () => {
    const sealed = await seal(Buffer.from('hello world'));
    sealed[sealed.length - 20] ^= 1;
    await expect(open(sealed)).rejects.toThrow(BackupCryptoError);
  });

  it('refuses a cut-off file at every length', async () => {
    const sealed = await seal(Buffer.alloc(CHUNK_SIZE + 10, 1));
    for (const cut of [10, 40, CHUNK_SIZE, sealed.length - 1]) {
      await expect(open(sealed.subarray(0, cut))).rejects.toThrow(
        BackupCryptoError,
      );
    }
  });

  it('refuses dropped or reordered blocks and trailing data', async () => {
    const sealed = await seal(Buffer.alloc(CHUNK_SIZE * 2 + 1, 2));
    const headerLength = 27;
    const block = 5 + CHUNK_SIZE + 16;
    const header = sealed.subarray(0, headerLength);
    const first = sealed.subarray(headerLength, headerLength + block);
    const second = sealed.subarray(
      headerLength + block,
      headerLength + 2 * block,
    );
    const last = sealed.subarray(headerLength + 2 * block);
    await expect(
      open(Buffer.concat([header, second, first, last])),
    ).rejects.toThrow(BackupCryptoError);
    await expect(open(Buffer.concat([header, first, last]))).rejects.toThrow(
      BackupCryptoError,
    );
    await expect(
      open(Buffer.concat([sealed, Buffer.from([0])])),
    ).rejects.toThrow(BackupCryptoError);
  });

  it('rejects a short passphrase', async () => {
    await expect(
      collect(encryptStream(Readable.from([Buffer.from('x')]), 'short')),
    ).rejects.toThrow(BackupCryptoError);
  });
});
