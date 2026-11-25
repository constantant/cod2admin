import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InlineKeyboard } from 'grammy';
import type { ActingAdmin, BotContext } from '../bot-context.js';
import type { GatewayDeps, UpdateFeatureConfig } from '../deps.js';
import type { GithubRelease } from '../github-releases.js';
import {
  downloadReleaseAsset,
  type DownloadProgress,
  runApplyUpdate,
  verifyChecksum,
  type ApplyUpdateProblem,
} from '../update-apply.js';
import { getRunningVersion, isNewerVersion } from '../version.js';

const CALLBACK_PREFIX = 'update:';
type UpdateAction = 'confirm' | 'cancel';

function encodeCallbackData(id: string, action: UpdateAction): string {
  return `${CALLBACK_PREFIX}${id}:${action}`;
}

interface DecodedCallback {
  id: string;
  action: UpdateAction;
}

function decodeCallbackData(data: string): DecodedCallback | null {
  if (!data.startsWith(CALLBACK_PREFIX)) {
    return null;
  }
  const [id, action] = data.slice(CALLBACK_PREFIX.length).split(':');
  if (!id || (action !== 'confirm' && action !== 'cancel')) {
    return null;
  }
  return { id, action };
}

export function formatConfirmMessage(
  release: GithubRelease,
  runningVersion: string,
): string {
  return [
    `Update to ${release.tagName}? Currently running ${runningVersion}.`,
    '',
    'This restarts the bot. It automatically rolls back if the new version fails to start.',
  ].join('\n');
}

/**
 * `/update` (owner-only, docs/PLAN.md §13.3 step 1). Re-checks the latest release itself rather
 * than trusting the version-check poller's last result — it may be stale, or nobody may have
 * hit the notification yet.
 */
export async function updateCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  if (!deps.updateConfig) {
    await ctx.reply(
      "Self-update isn't available on this install — re-run install.sh to enable it.",
    );
    return;
  }

  const release = await deps.githubReleaseClient.getLatestRelease();
  const runningVersion = getRunningVersion();
  if (!isNewerVersion(release.tagName, runningVersion)) {
    await ctx.reply(`Already up to date (running ${runningVersion}).`);
    return;
  }

  const id = deps.updateRegistry.reserveId();
  deps.updateRegistry.set(id, { release });
  const keyboard = new InlineKeyboard()
    .text('Update', encodeCallbackData(id, 'confirm'))
    .text('Cancel', encodeCallbackData(id, 'cancel'));
  await ctx.reply(formatConfirmMessage(release, runningVersion), {
    reply_markup: keyboard,
  });
}

/** Structural subset of grammy's callback-query `Context` — same approach as `reports.ts`'s `ReportCallbackContext`. */
export interface UpdateCallbackContext {
  from?: { id: number };
  chat?: { id: number };
  admin?: ActingAdmin;
  callbackData: string;
  editMessageText(text: string, other?: unknown): Promise<unknown>;
  answerCallbackQuery(other?: {
    text?: string;
    show_alert?: boolean;
  }): Promise<unknown>;
}

/**
 * The Update/Cancel button press (docs/PLAN.md §13.3 steps 2-5). `Cancel` just clears the
 * registry entry. `Confirm` downloads the gateway tarball + its checksum, verifies the checksum
 * *before* writing anything `apply-update.sh` would act on, writes the pending-update marker
 * (`CHAT_ID=`, matching what `apply-update.sh`'s failure-alert path already reads), audit-logs
 * the action, then fires `apply-update.sh` and returns without waiting for it — see
 * `update-apply.ts`'s `runApplyUpdate` doc comment for why it can't be awaited to completion.
 */
export async function updateActionCallback(
  ctx: UpdateCallbackContext,
  deps: GatewayDeps,
): Promise<void> {
  if (!deps.updateConfig) {
    await ctx.answerCallbackQuery({
      text: "Self-update isn't available on this install.",
      show_alert: true,
    });
    return;
  }
  const decoded = decodeCallbackData(ctx.callbackData);
  if (!decoded) {
    await ctx.answerCallbackQuery({ text: 'Unrecognized action.' });
    return;
  }
  const pending = deps.updateRegistry.get(decoded.id);
  if (!pending) {
    await ctx.answerCallbackQuery({
      text: 'This update card has expired (gateway restarted).',
      show_alert: true,
    });
    return;
  }

  if (decoded.action === 'cancel') {
    deps.updateRegistry.delete(decoded.id);
    await ctx.editMessageText('Update cancelled.');
    await ctx.answerCallbackQuery();
    return;
  }

  // Delete immediately (before any await) so a duplicate tap on the same button can't apply twice.
  deps.updateRegistry.delete(decoded.id);

  const admin = ctx.admin;
  const chatId = ctx.chat?.id;
  if (!admin || chatId === undefined) {
    await ctx.answerCallbackQuery({
      text: 'Could not determine who/where to update for.',
      show_alert: true,
    });
    return;
  }

  const { release } = pending;
  await ctx.editMessageText(`Downloading ${release.tagName}…`);
  const showProgress = throttledProgress((progress) => {
    void ctx
      .editMessageText(downloadText(release.tagName, progress))
      .catch(() => undefined); // an unchanged text or Telegram's edit limit must not fail the update
  });
  const staged = await stageRelease(
    release,
    deps.updateConfig,
    chatId,
    showProgress,
  );
  if (!staged.ok) {
    await ctx.editMessageText(staged.message);
    await ctx.answerCallbackQuery();
    return;
  }

  await deps.adminStore.recordAuditLog({
    actorTelegramId: admin.telegramId,
    action: 'update',
    target: release.tagName,
    source: 'telegram_command',
    detailJson: {
      tagName: release.tagName,
      assetName: release.gatewayAsset.name,
    },
  });

  await ctx.editMessageText(
    `Applying update to ${release.tagName}… the bot will restart shortly.`,
  );
  runApplyUpdate(deps.updateConfig.applyUpdateScriptPath, staged.tarballPath, {
    onProblem: (problem) => {
      void reportApplyProblem(ctx, problem, {
        tagName: release.tagName,
        command: `${deps.updateConfig?.applyUpdateScriptPath} ${staged.tarballPath}`,
        markerPath: staged.markerPath,
      });
    },
  });
  await ctx.answerCallbackQuery();
}

const MB = 1024 * 1024;
const megabytes = (bytes: number): string => (bytes / MB).toFixed(1);

/** `Downloading v1.27.1… 42% (3.2 of 7.5 MB)`, or the retry note when the connection dropped. */
export function downloadText(tag: string, progress: DownloadProgress): string {
  const size = progress.total
    ? `${Math.floor((progress.received / progress.total) * 100)}% (${megabytes(progress.received)} of ${megabytes(progress.total)} MB)`
    : `${megabytes(progress.received)} MB`;
  const retry = progress.retrying
    ? `\nThe connection dropped; trying again (${progress.attempt + 1} of ${progress.attempts}).`
    : '';
  return `Downloading ${tag}… ${size}${retry}`;
}

/**
 * Passes progress on at most every `minMs`, and always the retry notice. A chat message can be
 * edited only so often, and a download reports many times a second.
 */
export function throttledProgress(
  show: (progress: DownloadProgress) => void,
  minMs = 3000,
  now: () => number = Date.now,
): (progress: DownloadProgress) => void {
  let last = 0;
  return (progress) => {
    if (!progress.retrying && now() - last < minMs) {
      return;
    }
    last = now();
    show(progress);
  };
}

export type StagedRelease =
  | { ok: true; tarballPath: string; markerPath: string }
  | { ok: false; message: string };

/**
 * Downloads a release, verifies its checksum *before* writing anything `apply-update.sh` would act
 * on, and writes the pending-update marker the new version reports to (update-boot-check.ts).
 * `chatId` is where that report goes. Shared by `/update` and the Mini App.
 */
export async function stageRelease(
  release: GithubRelease,
  config: UpdateFeatureConfig,
  chatId: number,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<StagedRelease> {
  const tarballPath = path.join(config.stagingDir, release.gatewayAsset.name);
  const checksumPath = path.join(config.stagingDir, release.checksumAsset.name);
  try {
    await downloadReleaseAsset(
      release.gatewayAsset.downloadUrl,
      tarballPath,
      fetch,
      { onProgress },
    );
    await downloadReleaseAsset(release.checksumAsset.downloadUrl, checksumPath);
  } catch (error) {
    return {
      ok: false,
      message: `Failed to download ${release.tagName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!(await verifyChecksum(tarballPath, checksumPath))) {
    await Promise.all([
      rm(tarballPath, { force: true }),
      rm(checksumPath, { force: true }),
    ]);
    return {
      ok: false,
      message: `Checksum verification failed for ${release.tagName} — aborting, nothing was applied.`,
    };
  }
  const markerPath = path.join(config.stagingDir, 'pending-update.env');
  await writeFile(
    markerPath,
    `CHAT_ID=${chatId}\nVERSION=${release.tagName}\n`,
  );
  return { ok: true, tarballPath, markerPath };
}

async function reportApplyProblem(
  ctx: UpdateCallbackContext,
  problem: ApplyUpdateProblem,
  update: { tagName: string; command: string; markerPath: string },
): Promise<void> {
  const text = await settleApplyProblem(problem, update);
  await ctx.editMessageText(text).catch((error: unknown) => {
    console.error('Failed to report an update problem:', error);
  });
}

/** Words for a failed apply, also used by the Mini App. A finished failure clears the marker, so the next restart doesn't report on this update as well. */
export async function settleApplyProblem(
  problem: ApplyUpdateProblem,
  update: { tagName: string; command: string; markerPath: string },
): Promise<string> {
  const running = getRunningVersion();
  const runByHand = `To see what happens, run this on the server as root:\n${update.command}`;
  if (problem.kind === 'failed') {
    await rm(update.markerPath, { force: true });
    return (
      `❌ The update to ${update.tagName} didn't run. The bot is still on v${running}.\n\n` +
      (problem.output ? `${problem.output}\n\n` : '') +
      runByHand
    );
  }
  return `⚠️ The update to ${update.tagName} hasn't finished after 5 minutes. The bot is still on v${running}.\n\n${runByHand}`;
}
