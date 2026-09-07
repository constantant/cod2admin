import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { sampleRelease } from '../testing/fake-github-release-client.js';
import { getRunningVersion } from '../version.js';
import { formatConfirmMessage, updateActionCallback, updateCommand, type UpdateCallbackContext } from './update.js';

vi.mock('../update-apply.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../update-apply.js')>();
  return { ...actual, downloadReleaseAsset: vi.fn(), verifyChecksum: vi.fn(), runApplyUpdate: vi.fn() };
});
const { downloadReleaseAsset, verifyChecksum, runApplyUpdate } = await import('../update-apply.js');

function createFakeCallbackCtx(overrides: Partial<UpdateCallbackContext> = {}): UpdateCallbackContext {
  return {
    from: { id: 1 },
    chat: { id: 100 },
    admin: { telegramId: 1, role: 'owner' },
    callbackData: '',
    editMessageText: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(downloadReleaseAsset).mockReset().mockResolvedValue(undefined);
  vi.mocked(verifyChecksum).mockReset().mockResolvedValue(true);
  vi.mocked(runApplyUpdate).mockReset();
});

describe('updateCommand', () => {
  it('replies that self-update is unavailable when the feature is disabled', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = undefined;
    const ctx = createFakeCtx();

    await updateCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("isn't available"));
  });

  it('replies "already up to date" when the latest tag is not newer', async () => {
    const { deps, githubReleaseClient } = createFakeDeps();
    githubReleaseClient.getLatestRelease.mockResolvedValue(sampleRelease({ tagName: `v${getRunningVersion()}` }));
    const ctx = createFakeCtx();

    await updateCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('up to date'));
  });

  it('posts a confirm/cancel card and registers the pending update when a newer version exists', async () => {
    const { deps, githubReleaseClient } = createFakeDeps();
    githubReleaseClient.getLatestRelease.mockResolvedValue(sampleRelease({ tagName: 'v999.0.0' }));
    const ctx = createFakeCtx();

    await updateCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('v999.0.0'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(deps.updateRegistry.get('1')).toBeDefined();
  });
});

describe('formatConfirmMessage', () => {
  it('mentions the target version, running version, and rollback behavior', () => {
    const text = formatConfirmMessage(sampleRelease({ tagName: 'v0.0.5' }), '0.0.4');
    expect(text).toContain('v0.0.5');
    expect(text).toContain('0.0.4');
    expect(text).toContain('roll');
  });
});

describe('updateActionCallback', () => {
  // Only the confirm-success path below actually reaches the pending-update.env write - real
  // temp dir needed for that one, same reasoning as update-apply.spec.ts (no fs-mocking
  // precedent in this codebase; log-tailer's tests use real temp dirs too).
  let stagingDir: string;
  beforeAll(async () => {
    stagingDir = await mkdtemp(join(tmpdir(), 'cod2admin-update-cmd-test-'));
  });
  afterAll(async () => {
    await rm(stagingDir, { recursive: true, force: true });
  });

  it('answers with an alert when self-update is disabled', async () => {
    const { deps } = createFakeDeps();
    deps.updateConfig = undefined;
    const ctx = createFakeCallbackCtx({ callbackData: 'update:1:confirm' });

    await updateActionCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
  });

  it('answers when the callback data is unrecognized', async () => {
    const { deps } = createFakeDeps();
    const ctx = createFakeCallbackCtx({ callbackData: 'not-an-update-callback' });

    await updateActionCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it('says the card expired when the registry has no matching entry', async () => {
    const { deps } = createFakeDeps();
    const ctx = createFakeCallbackCtx({ callbackData: 'update:999:confirm' });

    await updateActionCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('expired') }));
  });

  it('cancel clears the registry entry and edits the message, without downloading anything', async () => {
    const { deps } = createFakeDeps();
    deps.updateRegistry.set('1', { release: sampleRelease() });
    const ctx = createFakeCallbackCtx({ callbackData: 'update:1:cancel' });

    await updateActionCallback(ctx, deps);

    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
    expect(deps.updateRegistry.get('1')).toBeUndefined();
    expect(downloadReleaseAsset).not.toHaveBeenCalled();
  });

  it('confirm downloads both assets, verifies the checksum, writes the marker, audit-logs, and applies', async () => {
    const { deps, adminStore } = createFakeDeps();
    deps.updateConfig = { stagingDir, applyUpdateScriptPath: join(stagingDir, '..', 'bin', 'apply-update.sh') };
    const release = sampleRelease();
    deps.updateRegistry.set('1', { release });
    const ctx = createFakeCallbackCtx({ callbackData: 'update:1:confirm' });

    await updateActionCallback(ctx, deps);

    expect(downloadReleaseAsset).toHaveBeenCalledWith(release.gatewayAsset.downloadUrl, expect.stringContaining(release.gatewayAsset.name));
    expect(downloadReleaseAsset).toHaveBeenCalledWith(
      release.checksumAsset.downloadUrl,
      expect.stringContaining(release.checksumAsset.name),
    );
    expect(verifyChecksum).toHaveBeenCalled();
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'update', target: release.tagName, source: 'telegram_command' }),
    );
    expect(runApplyUpdate).toHaveBeenCalledWith(
      deps.updateConfig?.applyUpdateScriptPath,
      expect.stringContaining(release.gatewayAsset.name),
    );
    expect(deps.updateRegistry.get('1')).toBeUndefined();
  });

  it('confirm aborts (no audit log, no apply) when the checksum does not match', async () => {
    vi.mocked(verifyChecksum).mockResolvedValue(false);
    const { deps, adminStore } = createFakeDeps();
    deps.updateRegistry.set('1', { release: sampleRelease() });
    const ctx = createFakeCallbackCtx({ callbackData: 'update:1:confirm' });

    await updateActionCallback(ctx, deps);

    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Checksum verification failed'));
    expect(adminStore.recordAuditLog).not.toHaveBeenCalled();
    expect(runApplyUpdate).not.toHaveBeenCalled();
  });

  it('confirm reports a download failure without applying anything', async () => {
    vi.mocked(downloadReleaseAsset).mockRejectedValue(new Error('network down'));
    const { deps, adminStore } = createFakeDeps();
    deps.updateRegistry.set('1', { release: sampleRelease() });
    const ctx = createFakeCallbackCtx({ callbackData: 'update:1:confirm' });

    await updateActionCallback(ctx, deps);

    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Failed to download'));
    expect(adminStore.recordAuditLog).not.toHaveBeenCalled();
    expect(runApplyUpdate).not.toHaveBeenCalled();
  });
});
