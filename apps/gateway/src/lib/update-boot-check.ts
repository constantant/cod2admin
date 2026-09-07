import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Bot } from 'grammy';
import type { GatewayDeps } from './deps.js';
import { getRunningVersion } from './version.js';

function parseChatId(markerContents: string): number | undefined {
  const line = markerContents.split('\n').find((entry) => entry.startsWith('CHAT_ID='));
  if (!line) {
    return undefined;
  }
  const value = Number.parseInt(line.slice('CHAT_ID='.length).trim(), 10);
  return Number.isNaN(value) ? undefined : value;
}

/**
 * docs/PLAN.md §13.3 step 6 — the "other side" of a successful update. `apply-update.sh` swaps
 * `current` and restarts the service; the OLD process that spawned it dies partway through, so it
 * can never confirm success itself (`update-apply.ts`'s `runApplyUpdate` doc comment). This is the
 * NEW process's job instead: if `staging/pending-update.env` (written by `commands/update.ts`
 * before it handed off to `apply-update.sh`) is still there, this was a restart caused by a
 * successful update — post the confirmation to the same chat and remove the marker.
 *
 * Must run, and be awaited, *before* `bot.start()` — `apply-update.sh`'s own health check is
 * "the log shows 'started as @...'", which only happens once `bot.start()`'s `onStart` fires.
 * Reading (and removing) the marker earlier than that guarantees this runs before anything else
 * could reasonably race it - there's nothing else that touches this marker on the new-process
 * side, but no reason to leave the race in even where it wouldn't currently bite.
 */
export async function checkPendingUpdateOnBoot(deps: GatewayDeps, bot: Bot): Promise<void> {
  if (!deps.updateConfig) {
    return;
  }
  const markerPath = path.join(deps.updateConfig.stagingDir, 'pending-update.env');

  let contents: string;
  try {
    contents = await readFile(markerPath, 'utf8');
  } catch {
    return; // no pending update - the common case (every boot that isn't right after an update)
  }

  try {
    const chatId = parseChatId(contents);
    if (chatId !== undefined) {
      await bot.api.sendMessage(chatId, `✅ Updated to v${getRunningVersion()}.`);
    }
  } catch (error) {
    console.error('Failed to send the post-update confirmation:', error);
  } finally {
    await unlink(markerPath).catch(() => {});
  }
}
