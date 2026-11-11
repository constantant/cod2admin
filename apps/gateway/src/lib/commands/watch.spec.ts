import {
  DEFAULT_SERVER_WATCH_SETTINGS,
  watchSettingsForStorage,
  type ServerConfig,
  type ServerWatchSettings,
} from '@cod2admin/admin-store';
import { GrammyError } from 'grammy';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { OWNER_ACCESS } from '../testing/fake-admin-store.js';
import { watchCommand } from './watch.js';

const OWNER = { telegramId: 1, ...OWNER_ACCESS };
const SECRET = 'do-not-audit-this';

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    alias: 'default',
    rconHost: '127.0.0.1',
    rconPort: 28960,
    rconPassword: 'pw',
    logSourceConfig: null,
    boundTelegramChatId: null,
    isDefault: true,
    watch: null,
    watchPrivatePassword: null,
    watchPrivatePasswordOwned: false,
    ...overrides,
  };
}

function stored(
  overrides: Partial<ServerWatchSettings> = {},
): ServerWatchSettings {
  return { ...DEFAULT_SERVER_WATCH_SETTINGS, ...overrides };
}

function setup(config?: Partial<ServerConfig>) {
  const fake = createFakeDeps();
  fake.adminStore.getServer.mockResolvedValue(server(config));
  fake.adminStore.setServerWatch.mockImplementation(
    async (_alias, settings) => {
      watchSettingsForStorage(settings);
      return true;
    },
  );
  return fake;
}

describe('watchCommand', () => {
  it('shows a null watch as off and does not reveal a private password', async () => {
    const { deps, adminStore, rcon } = setup({
      watchPrivatePassword: SECRET,
      watchPrivatePasswordOwned: true,
    });
    const ctx = createFakeCtx({ match: '', admin: OWNER });

    await watchCommand(ctx, deps);

    const text = vi.mocked(ctx.reply).mock.calls[0]?.[0];
    expect(text).toContain('watcher is off');
    expect(text).not.toContain(SECRET);
    expect(adminStore.setServerWatch).not.toHaveBeenCalled();
    expect(rcon.setCvar).not.toHaveBeenCalled();
    expect(rcon.rcon).not.toHaveBeenCalled();
  });

  it('stores enabled with mode off, and does not put the password in the audit', async () => {
    const { deps, adminStore } = setup({
      watchPrivatePassword: SECRET,
      watchPrivatePasswordOwned: true,
    });
    const ctx = createFakeCtx({ match: 'on', admin: OWNER });

    await watchCommand(ctx, deps);

    expect(adminStore.setServerWatch).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ enabled: true, mode: 'off' }),
    );
    const saved = adminStore.setServerWatch.mock.calls[0]?.[1];
    expect(saved).not.toHaveProperty('password');
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    const detail = adminStore.recordAuditLog.mock.calls[0]?.[0];
    expect(detail).toMatchObject({
      action: 'watch_settings',
      serverAlias: 'default',
    });
    expect(JSON.stringify(detail?.detailJson)).not.toContain(SECRET);
    expect(vi.mocked(ctx.reply).mock.calls[0]?.[0]).not.toContain(SECRET);
  });

  it('rejects kick mode when confirmedAimFeatures is not 2', async () => {
    const { deps, adminStore } = setup();
    const ctx = createFakeCtx({ match: 'mode kick', admin: OWNER });

    await watchCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('confirmedAimFeatures 2'),
    );
    expect(adminStore.recordAuditLog).not.toHaveBeenCalled();
  });

  it('refuses to show the private password in a group', async () => {
    const { deps, adminStore, rcon } = setup({
      watchPrivatePassword: SECRET,
    });
    const ctx = createFakeCtx({
      match: 'password',
      admin: OWNER,
      chat: { id: 100, type: 'group' },
    });

    await watchCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('private chat'),
    );
    expect(vi.mocked(ctx.reply).mock.calls[0]?.[0]).not.toContain(SECRET);
    expect(adminStore.recordAuditLog).not.toHaveBeenCalled();
    expect(rcon.setCvar).not.toHaveBeenCalled();
  });

  it('shows the private password once in a private chat and audits without it', async () => {
    const { deps, adminStore } = setup({
      watchPrivatePassword: SECRET,
      watchPrivatePasswordOwned: true,
    });
    const ctx = createFakeCtx({
      match: 'password',
      admin: OWNER,
      chat: { id: 1, type: 'private' },
    });

    await watchCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(SECRET);
    expect(vi.mocked(ctx.reply).mock.invocationCallOrder[0]).toBeLessThan(
      adminStore.recordAuditLog.mock.invocationCallOrder[0] ?? 0,
    );
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith({
      actorTelegramId: 1,
      action: 'watch_private_password_shown',
      serverAlias: 'default',
      source: 'telegram_command',
      detailJson: { owned: true },
    });
    expect(
      JSON.stringify(adminStore.recordAuditLog.mock.calls[0]?.[0]),
    ).not.toContain(SECRET);
  });

  it('does not audit or log the secret when the private reply fails', async () => {
    const { deps, adminStore } = setup({
      watchPrivatePassword: SECRET,
      watchPrivatePasswordOwned: true,
    });
    const ctx = createFakeCtx({
      match: 'password',
      admin: OWNER,
      chat: { id: 1, type: 'private' },
    });
    const failure = new GrammyError(
      "Call to 'sendMessage' failed!",
      {
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was blocked by the user',
      },
      'sendMessage',
      { chat_id: 1, text: SECRET },
    );
    vi.mocked(ctx.reply).mockRejectedValueOnce(failure);
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args);
    });

    await expect(watchCommand(ctx, deps)).rejects.toBe(failure);

    expect(failure).not.toHaveProperty('payload');
    expect(inspect(failure)).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(adminStore.recordAuditLog).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('records unreserve as spectator join and does not touch the game server', async () => {
    const watch = stored({
      enabled: true,
      join: 'private',
      privateClientsPrevious: 2,
    });
    const { deps, adminStore, rcon } = setup({
      watch,
      watchPrivatePassword: SECRET,
      watchPrivatePasswordOwned: true,
    });
    const ctx = createFakeCtx({ match: 'unreserve', admin: OWNER });

    await watchCommand(ctx, deps);

    expect(adminStore.setServerWatch).toHaveBeenCalledWith('default', {
      ...watch,
      join: 'spectator',
    });
    expect(adminStore.setWatchPrivatePassword).not.toHaveBeenCalled();
    expect(rcon.setCvar).not.toHaveBeenCalled();
    expect(rcon.rcon).not.toHaveBeenCalled();
    expect(rcon.kick).not.toHaveBeenCalled();
    const detail = adminStore.recordAuditLog.mock.calls[0]?.[0];
    expect(detail).toMatchObject({
      action: 'watch_unreserve',
      detailJson: {
        join: 'spectator',
        privateClientsPrevious: 2,
        passwordOwned: true,
      },
    });
    expect(JSON.stringify(detail)).not.toContain(SECRET);
    expect(vi.mocked(ctx.reply).mock.calls[0]?.[0]).not.toContain(SECRET);
  });
});
