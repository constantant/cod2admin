import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createWriteStream, openSync, readFileSync } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

type FetchFn = typeof fetch;

const APPLY_UPDATE_TIMEOUT_MS = 5 * 60_000;

export interface DownloadOptions {
  /** Give up on an attempt when no bytes arrive for this long. */
  idleMs?: number;
  /** Give up on the whole download after this long. */
  totalMs?: number;
  /** Tries, each continuing where the last one stopped when the server allows it. */
  attempts?: number;
  retryDelayMs?: number;
  /** Called as bytes arrive, and when an attempt fails and another is about to start. */
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadProgress {
  /** Bytes of the file on disk so far. */
  received: number;
  /** The whole file's size, when the server said. */
  total: number | null;
  attempt: number;
  attempts: number;
  /** The last attempt failed; this is the wait before the next one. */
  retrying: boolean;
}

const DEFAULT_DOWNLOAD: Required<Omit<DownloadOptions, 'onProgress'>> = {
  idleMs: 30_000,
  totalMs: 15 * 60_000,
  attempts: 6,
  retryDelayMs: 3_000,
};

/** A 4xx other than "slow down" will not get better by asking again. */
class FatalDownloadError extends Error {}

/**
 * Downloads a release asset (docs/PLAN.md §13.3 step 2) to `destPath`.
 *
 * The archive is several MB and the route to GitHub can be slow (hosts in Russia), so there is no
 * short limit on the whole transfer: an attempt only fails when it stalls (`idleMs` without a
 * byte), and a failed attempt asks for the rest with a `Range` request instead of starting over
 * (`totalMs` still caps everything). The bytes go to `<destPath>.part` and are moved into place
 * only when complete, so a half file is never taken for a release.
 * `fetchFn` is injectable (defaults to the global `fetch`) for the same DI-over-mocking-globals
 * reason as `github-releases.ts`.
 */
export async function downloadReleaseAsset(
  url: string,
  destPath: string,
  fetchFn: FetchFn = fetch,
  options: DownloadOptions = {},
): Promise<void> {
  const { idleMs, totalMs, attempts, retryDelayMs, onProgress } = {
    ...DEFAULT_DOWNLOAD,
    ...options,
  };
  const partPath = `${destPath}.part`;
  await rm(partPath, { force: true });
  const startedAt = Date.now();
  let received = 0;
  let knownTotal: number | null = null;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    let idleTimer = setTimeout(
      () => controller.abort(new Error(`no data for ${idleMs / 1000}s`)),
      idleMs,
    );
    const totalTimer = setTimeout(
      () => controller.abort(new Error('took too long overall')),
      Math.max(1, totalMs - (Date.now() - startedAt)),
    );
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => controller.abort(new Error(`no data for ${idleMs / 1000}s`)),
        idleMs,
      );
    };
    try {
      const res = await fetchFn(url, {
        signal: controller.signal,
        ...(received > 0 ? { headers: { Range: `bytes=${received}-` } } : {}),
      });
      if (!res.ok) {
        const message = `Failed to download ${url}: ${res.status} ${res.statusText}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new FatalDownloadError(message);
        }
        throw new Error(message);
      }
      // A server that ignores Range sends the whole file again.
      const resumed = received > 0 && res.status === 206;
      if (!resumed) {
        received = 0;
      }
      const expected = Number(res.headers?.get('content-length') ?? NaN);
      // `Content-Range: bytes 40-99/100` names the whole file even when this reply is the rest.
      const range = /\/(\d+)$/.exec(res.headers?.get('content-range') ?? '');
      const total = range
        ? Number(range[1])
        : Number.isFinite(expected) && !resumed
          ? expected
          : null;
      knownTotal = total ?? knownTotal;
      const report = (retrying = false) =>
        onProgress?.({ received, total, attempt, attempts, retrying });
      if (res.body) {
        const out = createWriteStream(partPath, { flags: resumed ? 'a' : 'w' });
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            resetIdle();
            report();
            callback(null, chunk);
          },
        });
        try {
          await pipeline(Readable.fromWeb(res.body as never), counter, out);
        } catch (error) {
          // What reached the disk is what a retry can build on.
          received = await stat(partPath).then(
            (info) => info.size,
            () => 0,
          );
          throw controller.signal.aborted
            ? (controller.signal.reason ?? error)
            : error;
        }
      } else {
        const buffer = Buffer.from(await res.arrayBuffer());
        await writeFile(partPath, buffer);
        received = buffer.length;
      }
      // `content-length` of a resumed response is only the rest, so it checks nothing here.
      if (Number.isFinite(expected) && !resumed && received !== expected) {
        throw new Error(`got ${received} of ${expected} bytes`);
      }
      await rename(partPath, destPath);
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof FatalDownloadError) {
        break;
      }
      if (Date.now() - startedAt >= totalMs) {
        break;
      }
      if (attempt < attempts) {
        onProgress?.({
          received,
          total: knownTotal,
          attempt,
          attempts,
          retrying: true,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
    }
  }
  await rm(partPath, { force: true });
  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
  if (lastError instanceof FatalDownloadError) {
    throw lastError;
  }
  throw new Error(
    `Failed to download ${url}: ${reason} (got ${received} bytes; the connection to GitHub is slow or unstable, try again in a few minutes)`,
  );
}

/**
 * Verifies `filePath` against a downloaded `sha256sum`-format file (`<hex>  <filename>`) at
 * `sha256FilePath` — both fetched fresh from the release in the same confirm step, never trusted
 * from a prior run. This is the checksum gate docs/PLAN.md §13.3 step 3 calls for, run *before*
 * anything is staged where `apply-update.sh` would act on it — defense in depth on top of that
 * script's own tar-member-path check, catching a corrupted/tampered download over the wire.
 */
export async function verifyChecksum(
  filePath: string,
  sha256FilePath: string,
): Promise<boolean> {
  const expectedLine = (await readFile(sha256FilePath, 'utf8')).trim();
  const expectedHash = expectedLine.split(/\s+/)[0]?.toLowerCase();
  if (!expectedHash) {
    return false;
  }
  const fileContent = await readFile(filePath);
  const actualHash = createHash('sha256').update(fileContent).digest('hex');
  return actualHash === expectedHash;
}

export type ApplyUpdateProblem =
  /** `sudo` refused or the script gave up, and this process is still the one running. */
  | { kind: 'failed'; output: string }
  /** Nothing has happened for a long time: no restart, and the script hasn't exited. */
  | { kind: 'timeout' };

export interface RunApplyUpdateOptions {
  onProblem(problem: ApplyUpdateProblem): void;
  timeoutMs?: number;
  /** What runs the script. Tests replace it, since `sudo` needs a real sudoers rule. */
  command?: string;
}

/** The end of the script's output, for the chat: it can repeat the bot's log, /claim secret included. */
function summarizeOutput(output: string): string {
  return (
    output
      .split('\n')
      .map((line) => line.trim())
      // Not "password": sudo's own "a password is required" is the message this exists to show.
      .filter((line) => line && !/claim|secret|token/i.test(line))
      .slice(-3)
      .join('\n')
      .slice(-400)
  );
}

/**
 * Fires `sudo <scriptPath> <tarballPath>` (installer/apply-update.sh, via the sudoers rule
 * install.sh installs) and returns immediately — deliberately does NOT wait for it to exit.
 * `apply-update.sh` restarts the service partway through, which kills *this* gateway process (the
 * one that just spawned it). `detached` + `unref()` lets the child survive that. Output goes to a
 * file rather than a pipe, because a pipe would break under the script when this process dies.
 *
 * A successful update is reported by the *new* process (`update-boot-check.ts`). This covers the
 * opposite: if this process is still here to see the script exit with an error, the update never
 * got as far as a restart, and nothing else would ever say so.
 */
export function runApplyUpdate(
  scriptPath: string,
  tarballPath: string,
  options: RunApplyUpdateOptions,
): void {
  const outputPath = path.join(path.dirname(tarballPath), 'apply-update.out');
  const outputFd = openSync(outputPath, 'w');
  const child = spawn(options.command ?? 'sudo', [scriptPath, tarballPath], {
    detached: true,
    stdio: ['ignore', outputFd, outputFd],
  });
  closeSync(outputFd);
  child.unref();

  const timer = setTimeout(
    () => options.onProblem({ kind: 'timeout' }),
    options.timeoutMs ?? APPLY_UPDATE_TIMEOUT_MS,
  );
  timer.unref?.();

  let finished = false;
  const fail = (extraOutput: string): void => {
    clearTimeout(timer);
    if (finished) {
      return;
    }
    finished = true;
    const output = `${readFileSafe(outputPath)}\n${extraOutput}`;
    options.onProblem({ kind: 'failed', output: summarizeOutput(output) });
  };

  // `sudo` itself can't start, e.g. it isn't installed. Unhandled, this event would crash the bot.
  child.on('error', (error) => fail(error.message));
  child.on('exit', (code) => {
    if (code === 0) {
      clearTimeout(timer);
    } else if (code !== null) {
      fail('');
    }
    // code === null: killed by a signal, which is the service restart taking this process down too.
  });
}

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}
