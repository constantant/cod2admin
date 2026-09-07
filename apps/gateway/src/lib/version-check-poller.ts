import type { AdminStore } from '@cod2admin/admin-store';
import type { Bot } from 'grammy';
import type { GatewayDeps } from './deps.js';
import { getRunningVersion, isNewerVersion } from './version.js';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h (docs/PLAN.md §13.2) - a version check doesn't need expiry-poller.ts's ~10s cadence.

async function findOwnerTelegramId(adminStore: AdminStore): Promise<number | undefined> {
  const admins = await adminStore.listAdmins();
  return admins.find((admin) => admin.role === 'owner')?.telegramId;
}

export function formatNewVersionMessage(tagName: string, runningVersion: string, notes: string): string {
  const lines = [`A new cod2admin version is available: ${tagName} (currently running ${runningVersion}).`, 'Run /update to install it.'];
  const trimmedNotes = notes.trim();
  if (trimmedNotes) {
    lines.push('', trimmedNotes);
  }
  return lines.join('\n');
}

/**
 * The real logic behind the poller (docs/PLAN.md §13.2) — kept separate from `setInterval` so
 * it's directly testable, same convention as `expiry-poller.ts` deferring to `ban-store`'s
 * `poller.ts`. DMs the **owner only** (not all admins) once per new tag — `deps.lastNotifiedTag`
 * is only updated after a successful send, so a transient Telegram failure gets retried on the
 * next tick rather than permanently suppressing the notification.
 */
export async function checkForNewVersion(deps: GatewayDeps, bot: Bot): Promise<void> {
  if (!deps.updateConfig) {
    return;
  }
  const release = await deps.githubReleaseClient.getLatestRelease();
  const runningVersion = getRunningVersion();
  if (!isNewerVersion(release.tagName, runningVersion)) {
    return;
  }
  if (deps.lastNotifiedTag === release.tagName) {
    return;
  }
  const ownerTelegramId = await findOwnerTelegramId(deps.adminStore);
  if (ownerTelegramId === undefined) {
    return; // no owner claimed yet - nobody to notify
  }
  await bot.api.sendMessage(ownerTelegramId, formatNewVersionMessage(release.tagName, runningVersion, release.notes));
  deps.lastNotifiedTag = release.tagName;
}

/**
 * Wires `checkForNewVersion` onto a fixed interval. No-ops (starts no timer, returns undefined)
 * when self-update is disabled on this install (`deps.updateConfig` unset) — matches
 * `checkForNewVersion`'s own early return, but avoids scheduling a timer that would just fire and
 * bail forever.
 */
export function startVersionCheckPoller(deps: GatewayDeps, bot: Bot, intervalMs = DEFAULT_INTERVAL_MS): NodeJS.Timeout | undefined {
  if (!deps.updateConfig) {
    return undefined;
  }
  return setInterval(() => {
    checkForNewVersion(deps, bot).catch((error: unknown) => {
      console.error('Version check failed:', error);
    });
  }, intervalMs);
}
