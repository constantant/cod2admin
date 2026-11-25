import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from 'node:crypto';

/**
 * Whole-file encryption for `.c2bak` files (docs/PLAN-backup.md §4).
 *
 * Layout: `magic(6) salt(16) logN(1) noncePrefix(4)`, then chunks of
 * `flag(1) ctLen(4, BE) ciphertext tag(16)`. Each chunk is AES-256-GCM with the nonce
 * `noncePrefix || chunkIndex(8, BE)` and the additional data `header || flag || chunkIndex`, so a
 * flipped byte, a dropped or reordered chunk and a cut-off file all fail authentication. The last
 * chunk has `flag = 1`; a stream that ends without one is truncated.
 */

export const MAGIC = Buffer.from('C2BAK\x01', 'latin1');
const SALT_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + 1 + 4;
const TAG_LENGTH = 16;
export const CHUNK_SIZE = 1024 * 1024;
const DEFAULT_LOG_N = 15;
const MAX_LOG_N = 20;

export const MIN_PASSPHRASE_LENGTH = 12;

export class BackupCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupCryptoError';
  }
}

export function assertPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new BackupCryptoError(
      `The passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    );
  }
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  logN: number,
): Promise<Buffer> {
  const N = 2 ** logN;
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize('NFKC'),
      salt,
      32,
      { N, r: 8, p: 1, maxmem: 256 * N * 8 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function chunkIndexBytes(index: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(index));
  return out;
}

function nonceFor(prefix: Buffer, index: number): Buffer {
  return Buffer.concat([prefix, chunkIndexBytes(index)]);
}

function sealChunk(
  key: Buffer,
  header: Buffer,
  prefix: Buffer,
  index: number,
  final: boolean,
  plain: Buffer,
): Buffer {
  const flag = Buffer.from([final ? 1 : 0]);
  const cipher = createCipheriv('aes-256-gcm', key, nonceFor(prefix, index));
  cipher.setAAD(Buffer.concat([header, flag, chunkIndexBytes(index)]));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(ct.length);
  return Buffer.concat([flag, length, ct, cipher.getAuthTag()]);
}

/** Encrypts a byte stream. The passphrase is stretched with scrypt using a fresh salt. */
export async function* encryptStream(
  source: AsyncIterable<Buffer>,
  passphrase: string,
  logN = DEFAULT_LOG_N,
): AsyncGenerator<Buffer> {
  assertPassphrase(passphrase);
  const salt = randomBytes(SALT_LENGTH);
  const prefix = randomBytes(4);
  const header = Buffer.concat([MAGIC, salt, Buffer.from([logN]), prefix]);
  const key = await deriveKey(passphrase, salt, logN);
  yield header;

  let index = 0;
  let pending: Buffer = Buffer.alloc(0);
  for await (const piece of source) {
    pending = pending.length ? Buffer.concat([pending, piece]) : piece;
    while (pending.length > CHUNK_SIZE) {
      yield sealChunk(
        key,
        header,
        prefix,
        index++,
        false,
        pending.subarray(0, CHUNK_SIZE),
      );
      pending = pending.subarray(CHUNK_SIZE);
    }
  }
  yield sealChunk(key, header, prefix, index, true, pending);
}

/** Reverses `encryptStream`. Throws `BackupCryptoError` for a wrong passphrase or damaged file. */
export async function* decryptStream(
  source: AsyncIterable<Buffer>,
  passphrase: string,
): AsyncGenerator<Buffer> {
  let buffer: Buffer = Buffer.alloc(0);
  const iterator = source[Symbol.asyncIterator]();
  let ended = false;

  const need = async (count: number): Promise<boolean> => {
    while (buffer.length < count) {
      if (ended) return false;
      const next = await iterator.next();
      if (next.done) {
        ended = true;
        return false;
      }
      buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value;
    }
    return true;
  };

  if (!(await need(HEADER_LENGTH))) {
    throw new BackupCryptoError('Not a cod2admin backup file (too short).');
  }
  const header = buffer.subarray(0, HEADER_LENGTH);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupCryptoError(
      'Not a cod2admin backup file (or an unsupported version).',
    );
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH);
  const logN = header[MAGIC.length + SALT_LENGTH];
  const prefix = header.subarray(MAGIC.length + SALT_LENGTH + 1);
  if (logN < 10 || logN > MAX_LOG_N) {
    throw new BackupCryptoError('The backup file header is damaged.');
  }
  buffer = buffer.subarray(HEADER_LENGTH);
  const key = await deriveKey(passphrase, Buffer.from(salt), logN);
  const headerCopy = Buffer.from(header);

  let index = 0;
  for (;;) {
    if (!(await need(5))) {
      throw new BackupCryptoError(
        'The backup file is cut off (it ends before its last block).',
      );
    }
    const flag = buffer[0];
    const length = buffer.readUInt32BE(1);
    if ((flag !== 0 && flag !== 1) || length > CHUNK_SIZE) {
      throw new BackupCryptoError('The backup file is damaged.');
    }
    if (!(await need(5 + length + TAG_LENGTH))) {
      throw new BackupCryptoError(
        'The backup file is cut off (it ends before its last block).',
      );
    }
    const ct = buffer.subarray(5, 5 + length);
    const tag = buffer.subarray(5 + length, 5 + length + TAG_LENGTH);
    let plain: Buffer;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        nonceFor(Buffer.from(prefix), index),
      );
      decipher.setAAD(
        Buffer.concat([
          headerCopy,
          Buffer.from([flag]),
          chunkIndexBytes(index),
        ]),
      );
      decipher.setAuthTag(Buffer.from(tag));
      plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new BackupCryptoError(
        index === 0
          ? 'Wrong passphrase, or the backup file is damaged.'
          : 'The backup file is damaged (a block failed its check).',
      );
    }
    buffer = buffer.subarray(5 + length + TAG_LENGTH);
    index++;
    if (plain.length) yield plain;
    if (flag === 1) {
      if (buffer.length > 0 || (await need(1))) {
        throw new BackupCryptoError(
          'The backup file has extra data after its last block.',
        );
      }
      return;
    }
  }
}
