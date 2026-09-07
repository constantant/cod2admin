import type { Bot } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { sampleAdmin } from './testing/fake-admin-store.js';
import { createFakeDeps } from './testing/fake-deps.js';
import { sampleRelease } from './testing/fake-github-release-client.js';
import { checkForNewVersion, formatNewVersionMessage } from './version-check-poller.js';
import { getRunningVersion } from './version.js';

function fakeBot(): Bot {
  return { api: { sendMessage: vi.fn().mockResolvedValue(undefined) } } as unknown as Bot;
}

describe('checkForNewVersion', () => {
  it('DMs the owner when a newer tag exists', async () => {
    const { deps, adminStore, githubReleaseClient } = createFakeDeps();
    adminStore.listAdmins.mockResolvedValue([sampleAdmin({ telegramId: 42, role: 'owner' })]);
    githubReleaseClient.getLatestRelease.mockResolvedValue(sampleRelease({ tagName: 'v999.0.0' }));
    const bot = fakeBot();

    await checkForNewVersion(deps, bot);

    expect(bot.api.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('v999.0.0'));
    expect(deps.lastNotifiedTag).toBe('v999.0.0');
  });

  it('stays quiet when the latest tag is not newer than the running version', async () => {
    const { deps, githubReleaseClient } = createFakeDeps();
    githubReleaseClient.getLatestRelease.mockResolvedValue(sampleRelease({ tagName: `v${getRunningVersion()}` }));
    const bot = fakeBot();

    await checkForNewVersion(deps, bot);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('does not re-notify the same tag twice', async () => {
    const { deps, adminStore, githubReleaseClient } = createFakeDeps();
    adminStore.listAdmins.mockResolvedValue([sampleAdmin({ telegramId: 42, role: 'owner' })]);
    githubReleaseClient.getLatestRelease.mockResolvedValue(sampleRelease({ tagName: 'v999.0.0' }));
    const bot = fakeBot();

    await checkForNewVersion(deps, bot);
    await checkForNewVersion(deps, bot);

    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no owner has been claimed yet', async () => {
    const { deps, adminStore, githubReleaseClient } = createFakeDeps();
    adminStore.listAdmins.mockResolvedValue([]);
    githubReleaseClient.getLatestRelease.mockResolvedValue(sampleRelease({ tagName: 'v999.0.0' }));
    const bot = fakeBot();

    await checkForNewVersion(deps, bot);

    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(deps.lastNotifiedTag).toBeUndefined();
  });

  it('is a no-op when self-update is disabled on this install', async () => {
    const { deps, githubReleaseClient } = createFakeDeps();
    deps.updateConfig = undefined;
    const bot = fakeBot();

    await checkForNewVersion(deps, bot);

    expect(githubReleaseClient.getLatestRelease).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('formatNewVersionMessage', () => {
  it('includes the tag, running version, and notes', () => {
    const text = formatNewVersionMessage('v0.0.5', '0.0.4', '- did a thing');
    expect(text).toContain('v0.0.5');
    expect(text).toContain('0.0.4');
    expect(text).toContain('/update');
    expect(text).toContain('- did a thing');
  });

  it('omits the trailing blank section when notes are empty', () => {
    const text = formatNewVersionMessage('v0.0.5', '0.0.4', '   ');
    expect(text.split('\n')).toHaveLength(2);
  });
});
