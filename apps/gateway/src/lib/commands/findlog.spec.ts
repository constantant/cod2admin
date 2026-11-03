import type { ServerConfig } from '@cod2admin/admin-store';
import type { GameLogTailer } from '@cod2admin/log-tailer';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { findLogCommand, type FindLogEnv } from './findlog.js';

const OWNER = { telegramId: 1, role: 'owner' as const };
const LIVE = { sv_hostname: 'CTF', mapname: 'mp_toujane', g_gametype: 'ctf' };
const LOG =
  '  0:00 InitGame: \\g_gametype\\ctf\\mapname\\mp_toujane\\sv_hostname\\CTF\n';

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    alias: 'default',
    rconHost: 'h',
    rconPort: 1,
    rconPassword: 'pw',
    logSourceConfig: null,
    boundTelegramChatId: null,
    isDefault: false,
    ...overrides,
  };
}

function setup() {
  const fake = createFakeDeps();
  fake.rcon.getStatus.mockResolvedValue({ cvars: LIVE, players: [] });
  const env: FindLogEnv = { startTailer: vi.fn(), decode: (b) => b.toString() };
  return { ...fake, env };
}

describe('findLogCommand', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'findlog-'));
    logPath = join(dir, 'games_mp.log');
    await writeFile(logPath, LOG);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sets a given path that belongs to this server and starts reading it', async () => {
    const { deps, adminStore, env } = setup();
    const saved = server({ logSourceConfig: logPath });
    adminStore.getServer.mockResolvedValue(saved);
    const ctx = createFakeCtx({ match: logPath, admin: OWNER });

    await findLogCommand(ctx, deps, env);

    expect(adminStore.setServerLogPath).toHaveBeenCalledWith('default', logPath);
    expect(env.startTailer).toHaveBeenCalledWith(saved);
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'setlogpath', target: logPath }),
    );
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('/bindserver default'));
  });

  it('replaces a tailer that is already running', async () => {
    const { deps, adminStore, env } = setup();
    adminStore.getServer.mockResolvedValue(server({ boundTelegramChatId: 5 }));
    const stop = vi.fn();
    deps.logTailers.set('default', { stop } as unknown as GameLogTailer);
    const ctx = createFakeCtx({ match: logPath, admin: OWNER });

    await findLogCommand(ctx, deps, env);

    expect(stop).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('go to the bound chat'));
  });

  it("refuses a file that isn't this server's log", async () => {
    const { deps, adminStore, env, rcon } = setup();
    rcon.getStatus.mockResolvedValue({
      cvars: { ...LIVE, sv_hostname: 'Other' },
      players: [],
    });
    const ctx = createFakeCtx({ match: logPath, admin: OWNER });

    await findLogCommand(ctx, deps, env);

    expect(adminStore.setServerLogPath).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('different server name'));
  });

  it('refuses a file with no map start or one it cannot read', async () => {
    const { deps, adminStore, env } = setup();
    const notLog = join(dir, 'notes.txt');
    await writeFile(notLog, 'secret\n');
    const notes = createFakeCtx({ match: notLog, admin: OWNER });
    const missing = createFakeCtx({ match: join(dir, 'nope.log'), admin: OWNER });

    await findLogCommand(notes, deps, env);
    await findLogCommand(missing, deps, env);

    expect(adminStore.setServerLogPath).not.toHaveBeenCalled();
    expect(notes.reply).toHaveBeenCalledWith(expect.stringContaining("isn't a CoD2 game log"));
    expect(missing.reply).toHaveBeenCalledWith(expect.stringContaining('no such file'));
  });

  // Root can read any file, so this can't fail the way it needs to when tests run as root.
  it.skipIf(process.getuid?.() === 0)('explains how to give access when the file exists but is unreadable', async () => {
    const { deps, adminStore, env } = setup();
    await chmod(logPath, 0o000);
    const ctx = createFakeCtx({ match: logPath, admin: OWNER });

    await findLogCommand(ctx, deps, env);

    expect(adminStore.setServerLogPath).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('allowed to open'));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('/findlog again'));
  });

  it('leaves a path from COD2_LOG_PATH alone', async () => {
    const { deps, adminStore, env } = setup();
    deps.bootstrapLogPath = '/env/games_mp.log';
    const ctx = createFakeCtx({ match: logPath, admin: OWNER });

    await findLogCommand(ctx, deps, env);

    expect(adminStore.setServerLogPath).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('remove COD2_LOG_PATH'));
  });

  it('turns log reading off', async () => {
    const { deps, adminStore, env } = setup();
    const stop = vi.fn();
    deps.logTailers.set('default', { stop } as unknown as GameLogTailer);
    const ctx = createFakeCtx({ match: 'off', admin: OWNER });

    await findLogCommand(ctx, deps, env);

    expect(adminStore.setServerLogPath).toHaveBeenCalledWith('default', null);
    expect(stop).toHaveBeenCalledOnce();
    expect(deps.logTailers.has('default')).toBe(false);
    expect(env.startTailer).not.toHaveBeenCalled();
  });

  it('shows usage for an argument that is neither a path nor off', async () => {
    const { deps, adminStore, env } = setup();
    const ctx = createFakeCtx({ match: 'games_mp.log', admin: OWNER });

    await findLogCommand(ctx, deps, env);

    expect(adminStore.setServerLogPath).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage: /findlog'));
  });
});
