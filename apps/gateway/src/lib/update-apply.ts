import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type FetchFn = typeof fetch;

const APPLY_UPDATE_TIMEOUT_MS = 5 * 60_000;

/**
 * Downloads a release asset (docs/PLAN.md §13.3 step 2) to `destPath`. Gateway/checksum assets
 * are a couple MB at most, so this buffers in memory rather than streaming to disk — simpler and
 * avoids Node's WHATWG-stream/Node-stream interop entirely, at a size this doesn't matter.
 * `fetchFn` is injectable (defaults to the global `fetch`) for the same DI-over-mocking-globals
 * reason as `github-releases.ts`.
 */
export async function downloadReleaseAsset(
  url: string,
  destPath: string,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(
      `Failed to download ${url}: ${res.status} ${res.statusText}`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buffer);
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
