import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AdminRole } from '@cod2admin/admin-store';
import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';
import type { GithubRelease } from '../github-releases.js';
import { downloadReleaseAsset, runApplyUpdate, verifyChecksum } from '../update-apply.js';
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

export function formatConfirmMessage(release: GithubRelease, runningVersion: string): string {
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
export async function updateCommand(ctx: BotContext, deps: GatewayDeps): Promise<void> {
  if (!deps.updateConfig) {
    await ctx.reply("Self-update isn't available on this install — re-run install.sh to enable it.");
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
  await ctx.reply(formatConfirmMessage(release, runningVersion), { reply_markup: keyboard });
}

/** Structural subset of grammy's callback-query `Context` — same approach as `reports.ts`'s `ReportCallbackContext`. */
export interface UpdateCallbackContext {
  from?: { id: number };
  chat?: { id: number };
  admin?: { telegramId: number; role: AdminRole };
  callbackData: string;
  editMessageText(text: string, other?: unknown): Promise<unknown>;
  answerCallbackQuery(other?: { text?: string; show_alert?: boolean }): Promise<unknown>;
}

/**
 * The Update/Cancel button press (docs/PLAN.md §13.3 steps 2-5). `Cancel` just clears the
 * registry entry. `Confirm` downloads the gateway tarball + its checksum, verifies the checksum
 * *before* writing anything `apply-update.sh` would act on, writes the pending-update marker
 * (`CHAT_ID=`, matching what `apply-update.sh`'s failure-alert path already reads), audit-logs
 * the action, then fires `apply-update.sh` and returns without waiting for it — see
 * `update-apply.ts`'s `runApplyUpdate` doc comment for why it can't be awaited to completion.
 */
export async function updateActionCallback(ctx: UpdateCallbackContext, deps: GatewayDeps): Promise<void> {
  if (!deps.updateConfig) {
    await ctx.answerCallbackQuery({ text: "Self-update isn't available on this install.", show_alert: true });
    return;
  }
  const decoded = decodeCallbackData(ctx.callbackData);
  if (!decoded) {
    await ctx.answerCallbackQuery({ text: 'Unrecognized action.' });
    return;
  }
  const pending = deps.updateRegistry.get(decoded.id);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: 'This update card has expired (gateway restarted).', show_alert: true });
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
    await ctx.answerCallbackQuery({ text: 'Could not determine who/where to update for.', show_alert: true });
    return;
  }

  const { release } = pending;
  const { stagingDir, applyUpdateScriptPath } = deps.updateConfig;
  const tarballPath = path.join(stagingDir, release.gatewayAsset.name);
  const checksumPath = path.join(stagingDir, release.checksumAsset.name);

  await ctx.editMessageText(`Downloading ${release.tagName}…`);
  try {
    await downloadReleaseAsset(release.gatewayAsset.downloadUrl, tarballPath);
    await downloadReleaseAsset(release.checksumAsset.downloadUrl, checksumPath);
  } catch (error) {
    await ctx.editMessageText(`Failed to download ${release.tagName}: ${error instanceof Error ? error.message : String(error)}`);
    await ctx.answerCallbackQuery();
    return;
  }

  const checksumOk = await verifyChecksum(tarballPath, checksumPath);
  if (!checksumOk) {
    await Promise.all([rm(tarballPath, { force: true }), rm(checksumPath, { force: true })]);
    await ctx.editMessageText(`Checksum verification failed for ${release.tagName} — aborting, nothing was applied.`);
    await ctx.answerCallbackQuery();
    return;
  }

  await writeFile(path.join(stagingDir, 'pending-update.env'), `CHAT_ID=${chatId}\n`);

  await deps.adminStore.recordAuditLog({
    actorTelegramId: admin.telegramId,
    action: 'update',
    target: release.tagName,
    source: 'telegram_command',
    detailJson: { tagName: release.tagName, assetName: release.gatewayAsset.name },
  });

  await ctx.editMessageText(`Applying update to ${release.tagName}… the bot will restart shortly.`);
  runApplyUpdate(applyUpdateScriptPath, tarballPath);
  await ctx.answerCallbackQuery();
}
