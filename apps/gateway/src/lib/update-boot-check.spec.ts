import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError, type Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps } from './testing/fake-deps.js';
import { sampleAdmin } from './testing/fake-admin-store.js';
import { checkPendingUpdateOnBoot } from './update-boot-check.js';
import { getRunningVersion } from './version.js';

function fakeBot(): Bot {
  return {
    api: { sendMessage: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Bot;
}

describe('checkPendingUpdateOnBoot', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cod2admin-boot-check-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is a no-op when self-update is disabled on this install', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = undefined;
    const bot = fakeBot();

    await checkPendingUpdateOnBoot(deps, bot);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no pending-update marker (the common case)', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = {
      stagingDir: dir,
      applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh'),
    };
    const bot = fakeBot();

    await checkPendingUpdateOnBoot(deps, bot);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('sends a confirmation to the marker chat id and removes the marker', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = {
      stagingDir: dir,
      applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh'),
    };
    const markerPath = join(dir, 'pending-update.env');
    await writeFile(markerPath, 'CHAT_ID=704781\n');
    const bot = fakeBot();

    await checkPendingUpdateOnBoot(deps, bot);

    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      704781,
      `✅ Updated to v${getRunningVersion()}.`,
      undefined,
      expect.any(AbortSignal),
    );
    await expect(readFile(markerPath)).rejects.toThrow();
  });

  it("says so when the running version isn't the one the update was for", async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = {
      stagingDir: dir,
      applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh'),
    };
    await writeFile(
      join(dir, 'pending-update.env'),
      'CHAT_ID=704781\nVERSION=v99.0.0\n',
    );
    const bot = fakeBot();

    await checkPendingUpdateOnBoot(deps, bot);

    expect(bot.api.sendMessage).toHaveBeenCalledWith(
      704781,
      `⚠️ The update to v99.0.0 didn't apply. Still running v${getRunningVersion()}.`,
      undefined,
      expect.any(AbortSignal),
    );
  });

  it('confirms when the marker names the running version', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = {
      stagingDir: dir,
      applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh'),
    };
    await writeFile(
      join(dir, 'pending-update.env'),
      `CHAT_ID=704781\nVERSION=v${getRunningVersion()}\n`,
    );
    const bot = fakeBot();

    await checkPendingUpdateOnBoot(deps, bot);

    expect(vi.mocked(bot.api.sendMessage).mock.calls[0][1]).toContain('✅');
  });

  it('retries a failed send, keeping the marker until it goes through', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = {
      stagingDir: dir,
      applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh'),
    };
    const markerPath = join(dir, 'pending-update.env');
    await writeFile(markerPath, 'CHAT_ID=704781\n');
    const bot = fakeBot();
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    let markerDuringRetry = '';
    vi.mocked(bot.api.sendMessage)
      .mockRejectedValueOnce(new Error('network'))
      .mockImplementationOnce(async () => {
        markerDuringRetry = await readFile(markerPath, 'utf8');
        throw new Error('network');
      })
      .mockResolvedValueOnce(undefined as never);

    await checkPendingUpdateOnBoot(deps, bot, { retryDelaysMs: [0, 0, 0] });

    error.mockRestore();
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(3);
    expect(markerDuringRetry).toContain('CHAT_ID=704781');
    await expect(readFile(markerPath)).rejects.toThrow();
  });

  it("doesn't retry when Telegram itself refuses the message", async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = {
      stagingDir: dir,
      applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh'),
    };
    await writeFile(join(dir, 'pending-update.env'), 'CHAT_ID=704781\n');
    const bot = fakeBot();
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    vi.mocked(bot.api.sendMessage).mockRejectedValue(
      new GrammyError(
        'Call failed',
        {
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found',
        },
        'sendMessage',
        {},
      ),
    );

    await checkPendingUpdateOnBoot(deps, bot, { retryDelaysMs: [0, 0] });

    error.mockRestore();
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('removes the marker even when it has no parseable CHAT_ID, without sending', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = {
      stagingDir: dir,
      applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh'),
    };
    const markerPath = join(dir, 'pending-update.env');
    await writeFile(markerPath, 'not a chat id line\n');
    const bot = fakeBot();

    await checkPendingUpdateOnBoot(deps, bot);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    await expect(readFile(markerPath)).rejects.toThrow();
  });

  describe('after a rollback', () => {
    const FAILED_LOG =
      '2026-11-03T17:06:03Z Applying cod2admin-gateway-9.9.9.tar.gz (version 9.9.9)\n' +
      '2026-11-03T17:06:30Z Update to v9.9.9 FAILED - rolling back to releases/1.0.0.\n' +
      '2026-11-03T17:06:40Z Rollback to releases/1.0.0 succeeded.\n';

    const setup = async (log: string) => {
      const fake = createFakeDeps();
      const stagingDir = join(dir, 'staging');
      await mkdir(stagingDir);
      await writeFile(join(dir, 'update.log'), log);
      fake.deps.updateConfig = { stagingDir, applyUpdateScriptPath: '' };
      fake.adminStore.listAdmins.mockResolvedValue([
        sampleAdmin({ telegramId: 42 }),
      ]);
      return { ...fake, bot: fakeBot() };
    };

    it("tells the owner once, over the bot's own route", async () => {
      const { deps, adminStore, bot } = await setup(FAILED_LOG);

      await checkPendingUpdateOnBoot(deps, bot);

      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        42,
        expect.stringContaining(
          'The update to v9.9.9 failed and was rolled back',
        ),
        undefined,
        expect.any(AbortSignal),
      );
      const failedLine = FAILED_LOG.split('\n')[1];
      expect(adminStore.setSetting).toHaveBeenCalledWith(
        'update.reportedFailure',
        failedLine,
      );

      adminStore.getSetting.mockResolvedValue(failedLine);
      vi.mocked(bot.api.sendMessage).mockClear();
      await checkPendingUpdateOnBoot(deps, bot);
      expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores a failure that a later update has replaced', async () => {
      const { deps, bot } = await setup(
        `${FAILED_LOG}2026-11-03T18:00:00Z Applying cod2admin-gateway-9.9.10.tar.gz (version 9.9.10)\n` +
          '2026-11-03T18:00:05Z Update to v9.9.10 succeeded.\n',
      );

      await checkPendingUpdateOnBoot(deps, bot);

      expect(bot.api.sendMessage).not.toHaveBeenCalled();
    });

    it('tries again on the next start if it could not get the message out', async () => {
      const { deps, adminStore, bot } = await setup(FAILED_LOG);
      const error = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      vi.mocked(bot.api.sendMessage).mockRejectedValue(new Error('network'));

      await checkPendingUpdateOnBoot(deps, bot, { retryDelaysMs: [0] });

      error.mockRestore();
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
      expect(adminStore.setSetting).not.toHaveBeenCalled();
    });
  });

  it('still removes the marker once every attempt has failed', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = {
      stagingDir: dir,
      applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh'),
    };
    const markerPath = join(dir, 'pending-update.env');
    await writeFile(markerPath, 'CHAT_ID=704781\n');
    const bot = fakeBot();
    vi.mocked(bot.api.sendMessage).mockRejectedValue(
      new Error('chat not found'),
    );

    await checkPendingUpdateOnBoot(deps, bot, { retryDelaysMs: [0] });

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    await expect(readFile(markerPath)).rejects.toThrow();
  });
});
