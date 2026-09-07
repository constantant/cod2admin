import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// This module compiles to dist/lib/version.js; apps/gateway/package.json sits at the bundle
// root (scripts/build-installer-bundle.sh copies it there as the deployed entry point), two
// levels up — same package-root trick commands/help.ts uses for docs/BOT-HELP*.md, just one
// level shallower since version.ts lives in lib/, not lib/commands/.
const PACKAGE_JSON_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));

let cachedVersion: string | undefined;

/** The running gateway's own version (docs/PLAN.md §13.2), read from apps/gateway/package.json. */
export function getRunningVersion(): string {
  if (cachedVersion === undefined) {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { version: string };
    cachedVersion = pkg.version;
  }
  return cachedVersion;
}

/**
 * Plain numeric dot-segment comparison (no semver dependency, matching config.ts's hand-rolled
 * style) — `latestTag` is a GitHub release tag like "v0.0.5" or "0.0.5". Returns false (not
 * newer) for anything that doesn't parse as dotted numbers, rather than risk repeatedly nagging
 * the owner about a tag it can't actually compare.
 */
export function isNewerVersion(latestTag: string, runningVersion: string): boolean {
  const latest = latestTag.replace(/^v/, '').split('.').map(Number);
  const running = runningVersion.replace(/^v/, '').split('.').map(Number);
  if (latest.some(Number.isNaN) || running.some(Number.isNaN)) {
    return false;
  }
  const length = Math.max(latest.length, running.length);
  for (let i = 0; i < length; i++) {
    const latestPart = latest[i] ?? 0;
    const runningPart = running[i] ?? 0;
    if (latestPart !== runningPart) {
      return latestPart > runningPart;
    }
  }
  return false;
}
