import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { GrammyError, type Bot } from 'grammy';
import type { GatewayDeps } from './deps.js';
import { getRunningVersion } from './version.js';

/** About 9 minutes in all: enough for a relay or a route switch to recover after a restart. */
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
/** A cut connection can hang rather than fail, and grammy would wait 500 seconds by default. */
const ATTEMPT_TIMEOUT_MS = 20_000;
/** The `update.log` line of the last rollback the owner was told about, so it's reported once. */
const REPORTED_FAILURE_SETTING_KEY = 'update.reportedFailure';

function markerValue(markerContents: string, key: string): string | undefined {
  return markerContents
    .split('\n')
    .find((entry) => entry.startsWith(`${key}=`))
    ?.slice(key.length + 1)
    .trim();
}

function parseChatId(markerContents: string): number | undefined {
  const value = Number.parseInt(markerValue(markerContents, 'CHAT_ID') ?? '', 10);
  return Number.isNaN(value) ? undefined : value;
}

function confirmationText(markerContents: string): string {
  const running = getRunningVersion();
  const target = markerValue(markerContents, 'VERSION')?.replace(/^v/, '');
  return target && target !== running
    ? `⚠️ The update to v${target} didn't apply. Still running v${running}.`
    : `✅ Updated to v${running}.`;
}

/** Telegram refused the message itself (e.g. the chat is gone), so sending again won't help. */
function isPermanentFailure(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code < 500 &&
    error.error_code !== 429
  );
}

export interface PendingUpdateCheckOptions {
  retryDelaysMs?: readonly number[];
  attemptTimeoutMs?: number;
}

/**
 * docs/PLAN.md §13.3 step 6 — the "other side" of a successful update. `apply-update.sh` swaps
 * `current` and restarts the service; the OLD process that spawned it dies partway through, so it
 * can never confirm success itself (`update-apply.ts`'s `runApplyUpdate` doc comment). This is the
 * NEW process's job instead: if `staging/pending-update.env` (written by `commands/update.ts`
 * before it handed off to `apply-update.sh`) is still there, post the result to the same chat and
 * remove the marker.
 *
 * A restart is the worst moment for a slow or flaky route, such as a relay from Russia, so a failed
 * send is retried and the marker stays until it's resolved: a restart in between tries again. Don't
 * wait for this before `bot.start()`, or a bad connection would keep the bot from starting.
 */
export async function checkPendingUpdateOnBoot(
  deps: GatewayDeps,
  bot: Bot,
  options: PendingUpdateCheckOptions = {},
): Promise<void> {
  await reportRolledBackUpdate(deps, bot, options).catch((error: unknown) => {
    console.error('Failed to check for a rolled-back update:', error);
  });

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

  const chatId = parseChatId(contents);
  if (chatId !== undefined) {
    await sendWithRetries(bot, chatId, confirmationText(contents), options);
  }
  await unlink(markerPath).catch(() => {});
}

/** True if the message went out. */
async function sendWithRetries(
  bot: Bot,
  chatId: number,
  text: string,
  options: PendingUpdateCheckOptions,
): Promise<boolean> {
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const timeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      // grammy declares its own AbortSignal type; the standard one works at runtime.
      const signal = AbortSignal.timeout(timeoutMs) as unknown as Parameters<Bot['api']['sendMessage']>[3];
      await bot.api.sendMessage(chatId, text, undefined, signal);
      return true;
    } catch (error) {
      console.error(
        `Failed to send the post-update confirmation (attempt ${attempt + 1} of ${delays.length + 1}):`,
        error,
      );
      if (isPermanentFailure(error) || attempt === delays.length) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  return false;
}

/**
 * Tells the owner when the latest update in `update.log` failed and was rolled back. The script's
 * own alert goes straight to api.telegram.org, which can't work on a host that needs a relay, and
 * `/update` never replaces the installed script. So this runs in the restored version, which has a
 * working route, and reads the log line the script has always written.
 */
async function reportRolledBackUpdate(
  deps: GatewayDeps,
  bot: Bot,
  options: PendingUpdateCheckOptions,
): Promise<void> {
  if (!deps.updateConfig) {
    return;
  }
  const logPath = path.join(path.dirname(deps.updateConfig.stagingDir), 'update.log');
  const lines = await readFile(logPath, 'utf8').then(
    (text) => text.split('\n'),
    () => [],
  );
  const latestStart = lines.map((line) => line.includes(' Applying ')).lastIndexOf(true);
  const latest = lines.slice(Math.max(latestStart, 0));
  const failure = latest.find((line) => /Update to \S+ FAILED/.test(line));
  if (!failure || (await deps.adminStore.getSetting(REPORTED_FAILURE_SETTING_KEY)) === failure) {
    return;
  }
  const owner = (await deps.adminStore.listAdmins()).find((admin) => admin.role === 'owner');
  if (!owner) {
    return;
  }
  const version = /Update to (\S+) FAILED/.exec(failure)?.[1];
  const sent = await sendWithRetries(
    bot,
    owner.telegramId,
    `❌ The update to ${version} failed and was rolled back. The bot is running v${getRunningVersion()}.`,
    options,
  );
  if (sent) {
    await deps.adminStore.setSetting(REPORTED_FAILURE_SETTING_KEY, failure);
  }
}
