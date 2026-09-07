import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps } from './testing/fake-deps.js';
import { checkPendingUpdateOnBoot } from './update-boot-check.js';
import { getRunningVersion } from './version.js';

function fakeBot(): Bot {
  return { api: { sendMessage: vi.fn().mockResolvedValue(undefined) } } as unknown as Bot;
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
    deps.updateConfig = { stagingDir: dir, applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh') };
    const bot = fakeBot();

    await checkPendingUpdateOnBoot(deps, bot);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('sends a confirmation to the marker chat id and removes the marker', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = { stagingDir: dir, applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh') };
    const markerPath = join(dir, 'pending-update.env');
    await writeFile(markerPath, 'CHAT_ID=704781\n');
    const bot = fakeBot();

    await checkPendingUpdateOnBoot(deps, bot);

    expect(bot.api.sendMessage).toHaveBeenCalledWith(704781, expect.stringContaining(getRunningVersion()));
    await expect(readFile(markerPath)).rejects.toThrow();
  });

  it('removes the marker even when it has no parseable CHAT_ID, without sending', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = { stagingDir: dir, applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh') };
    const markerPath = join(dir, 'pending-update.env');
    await writeFile(markerPath, 'not a chat id line\n');
    const bot = fakeBot();

    await checkPendingUpdateOnBoot(deps, bot);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    await expect(readFile(markerPath)).rejects.toThrow();
  });

  it('still removes the marker if sending the confirmation fails', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = { stagingDir: dir, applyUpdateScriptPath: join(dir, '..', 'bin', 'apply-update.sh') };
    const markerPath = join(dir, 'pending-update.env');
    await writeFile(markerPath, 'CHAT_ID=704781\n');
    const bot = fakeBot();
    vi.mocked(bot.api.sendMessage).mockRejectedValue(new Error('chat not found'));

    await checkPendingUpdateOnBoot(deps, bot);

    await expect(readFile(markerPath)).rejects.toThrow();
  });
});
