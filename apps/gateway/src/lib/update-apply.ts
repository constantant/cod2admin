import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

type FetchFn = typeof fetch;

/**
 * Downloads a release asset (docs/PLAN.md §13.3 step 2) to `destPath`. Gateway/checksum assets
 * are a couple MB at most, so this buffers in memory rather than streaming to disk — simpler and
 * avoids Node's WHATWG-stream/Node-stream interop entirely, at a size this doesn't matter.
 * `fetchFn` is injectable (defaults to the global `fetch`) for the same DI-over-mocking-globals
 * reason as `github-releases.ts`.
 */
export async function downloadReleaseAsset(url: string, destPath: string, fetchFn: FetchFn = fetch): Promise<void> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
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
export async function verifyChecksum(filePath: string, sha256FilePath: string): Promise<boolean> {
  const expectedLine = (await readFile(sha256FilePath, 'utf8')).trim();
  const expectedHash = expectedLine.split(/\s+/)[0]?.toLowerCase();
  if (!expectedHash) {
    return false;
  }
  const fileContent = await readFile(filePath);
  const actualHash = createHash('sha256').update(fileContent).digest('hex');
  return actualHash === expectedHash;
}

/**
 * Fires `sudo <scriptPath> <tarballPath>` (installer/apply-update.sh, via the sudoers rule
 * install.sh installs) and returns immediately — deliberately does NOT wait for it to exit.
 * `apply-update.sh` restarts the service partway through, which kills *this* gateway process (the
 * one that just spawned it) before it could ever observe a normal exit. `detached` + `unref()`
 * lets the child survive independently of this process's lifecycle regardless of exactly when
 * that restart lands. Success/failure is reported back later: on success by the *new* process
 * (checks a pending-update marker on boot - separate follow-up, not in this pass); on failure by
 * apply-update.sh itself, which can still see the failure and has its own Telegram-alert path.
 */
export function runApplyUpdate(scriptPath: string, tarballPath: string): void {
  const child = spawn('sudo', [scriptPath, tarballPath], { detached: true, stdio: 'ignore' });
  child.unref();
}
