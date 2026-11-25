import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';

/**
 * Splits a finished file into `<path>.001`, `<path>.002`, ... of at most `maxBytes` each, for
 * sending over Telegram's 50 MB document limit. Returns the part paths.
 */
export async function splitFile(
  path: string,
  maxBytes: number,
): Promise<string[]> {
  const { size } = await stat(path);
  const input = await open(path, 'r');
  const parts: string[] = [];
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes, 4 * 1024 * 1024));
    for (let offset = 0, index = 1; offset < size; index++) {
      const partPath = `${path}.${String(index).padStart(3, '0')}`;
      const output = await open(partPath, 'w', 0o600);
      try {
        let written = 0;
        while (written < maxBytes && offset < size) {
          const want = Math.min(
            buffer.length,
            maxBytes - written,
            size - offset,
          );
          const { bytesRead } = await input.read(buffer, 0, want, offset);
          if (!bytesRead) break;
          await output.write(buffer, 0, bytesRead);
          written += bytesRead;
          offset += bytesRead;
        }
      } finally {
        await output.close();
      }
      parts.push(partPath);
    }
  } finally {
    await input.close();
  }
  return parts;
}

/** Reads part files in the order given as one stream, for `restoreBackup`. */
export async function* joinParts(
  paths: readonly string[],
): AsyncGenerator<Buffer> {
  for (const path of paths) {
    const stream: Readable = createReadStream(path);
    for await (const chunk of stream) yield chunk as Buffer;
  }
}
