import type { ServerConfig } from '@cod2admin/admin-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDeps } from './testing/fake-deps.js';

const fakeTailerInstances: FakeTailer[] = [];

interface FakeTailer {
  logPath: string;
  listeners: Record<string, ((...args: unknown[]) => void)[]>;
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
}

vi.mock('@cod2admin/log-tailer', () => {
  class MockGameLogTailer implements FakeTailer {
    logPath: string;
    listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      (this.listeners[event] ??= []).push(listener);
      return this;
    });
    start = vi.fn().mockResolvedValue(undefined);
    getSession = vi.fn();
    listSessions = vi.fn().mockReturnValue([]);

    constructor(options: { logPath: string }) {
      this.logPath = options.logPath;
      fakeTailerInstances.push(this);
    }
  }
  return { GameLogTailer: MockGameLogTailer };
});

const { startReportTailers } = await import('./report-tailers.js');

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    alias: 'default',
    rconHost: '127.0.0.1',
    rconPort: 28960,
    rconPassword: 'pw',
    logSourceConfig: './games_mp.log',
    boundTelegramChatId: 555,
    isDefault: false,
    ...overrides,
  };
}

describe('startReportTailers', () => {
  beforeEach(() => {
    fakeTailerInstances.length = 0;
  });

  it('starts a tailer for a server with both a log path and a bound chat', () => {
    const { deps } = createFakeDeps();

    const tailers = startReportTailers([serverConfig()], deps, {} as never);

    expect(tailers).toHaveLength(1);
    expect(fakeTailerInstances[0].logPath).toBe('./games_mp.log');
    expect(fakeTailerInstances[0].start).toHaveBeenCalledOnce();
    expect(fakeTailerInstances[0].on).toHaveBeenCalledWith(
      'reportTrigger',
      expect.any(Function),
    );
    expect(fakeTailerInstances[0].on).toHaveBeenCalledWith(
      'error',
      expect.any(Function),
    );
    expect(deps.sessionsByServer.get('default')).toBe(fakeTailerInstances[0]);
  });

  it('skips a server with no log path configured', () => {
    const { deps } = createFakeDeps();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const tailers = startReportTailers(
      [serverConfig({ logSourceConfig: null })],
      deps,
      {} as never,
    );

    expect(tailers).toHaveLength(0);
    expect(fakeTailerInstances).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no log path configured'),
    );
    warn.mockRestore();
  });

  it('still tails a server with no bound Telegram chat (for the Mini App chat), but sends no report cards', async () => {
    const { deps, rcon } = createFakeDeps();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const tailers = startReportTailers(
      [serverConfig({ boundTelegramChatId: null })],
      deps,
      {} as never,
    );

    expect(tailers).toHaveLength(1);
    expect(deps.logTailers.get('default')).toBe(fakeTailerInstances[0]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no bound Telegram chat'),
    );
    fakeTailerInstances[0].listeners['reportTrigger'][0]({
      chat: {},
      targetName: 'X',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rcon.status).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips a server whose alias has no matching rconClients entry', () => {
    const { deps } = createFakeDeps();

    const tailers = startReportTailers(
      [serverConfig({ alias: 'unknown-server' })],
      deps,
      {} as never,
    );

    expect(tailers).toHaveLength(0);
  });

  it('starts one tailer per qualifying server, independently', () => {
    const { deps } = createFakeDeps();
    deps.rconClients.set('second', deps.rconClients.get('default')!);

    const tailers = startReportTailers(
      [
        serverConfig({ alias: 'default' }),
        serverConfig({ alias: 'second', boundTelegramChatId: 777 }),
      ],
      deps,
      {} as never,
    );

    expect(tailers).toHaveLength(2);
    expect(deps.sessionsByServer.has('default')).toBe(true);
    expect(deps.sessionsByServer.has('second')).toBe(true);
  });

  it("calls handleReportTrigger when the tailer's reportTrigger event fires", async () => {
    const { deps, rcon, adminStore } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [] });
    // Bound after the tailer started: /bindserver has to work without a restart.
    adminStore.getServer.mockResolvedValue(serverConfig());

    startReportTailers([serverConfig({ boundTelegramChatId: null })], deps, {
      api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) },
    } as never);

    const trigger = {
      chat: {
        channel: 'say' as const,
        guid: '0',
        num: 1,
        name: 'Reporter',
        message: '!report X',
        timestamp: { minutes: 0, seconds: 0 },
        raw: '',
      },
      targetName: 'X',
    };
    const reportTriggerListener =
      fakeTailerInstances[0].listeners['reportTrigger'][0];
    reportTriggerListener(trigger);

    // handleReportTrigger is async and fire-and-forget from the listener - give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rcon.status).toHaveBeenCalled();
  });

  describe('saving reports for the Mini App queue', () => {
    const trigger = {
      chat: { num: 1, guid: '0', name: 'Honest', message: '!report Cheater', channel: 'say' },
      targetName: 'Cheater',
    };
    const fire = async () => {
      fakeTailerInstances[0].listeners['reportTrigger']![0](trigger);
      await new Promise((resolve) => setTimeout(resolve, 20));
    };

    it('saves a report with no bound chat, and holds back a flood from one reporter', async () => {
      const { deps, adminStore } = createFakeDeps();
      adminStore.getServer.mockResolvedValue(serverConfig({ boundTelegramChatId: null }));
      const record = vi.spyOn(deps.reportQueue, 'record');
      startReportTailers([serverConfig({ boundTelegramChatId: null })], deps, {} as never);

      await fire();
      expect(record).toHaveBeenCalledTimes(1);

      fakeTailerInstances[0].listeners['reportTrigger']![0]({ ...trigger, targetName: 'Someone else' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(record).toHaveBeenCalledTimes(1);
    });

    it('saves the report even when Telegram cannot be reached', async () => {
      const { deps, adminStore, rcon } = createFakeDeps();
      adminStore.getServer.mockResolvedValue(serverConfig());
      rcon.status.mockResolvedValue({ raw: '', players: [] });
      const record = vi.spyOn(deps.reportQueue, 'record');
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const bot = { api: { sendMessage: vi.fn().mockRejectedValue(new Error('no route')) } };
      startReportTailers([serverConfig()], deps, bot as never);

      await fire();

      expect(record).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it('links the saved report to the card it sent', async () => {
      const { deps, adminStore, rcon } = createFakeDeps();
      adminStore.getServer.mockResolvedValue(serverConfig());
      rcon.status.mockResolvedValue({ raw: '', players: [] });
      const bot = { api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 9 }) } };
      startReportTailers([serverConfig()], deps, bot as never);

      await fire();

      expect(deps.reportRegistry.findByQueueId(1)?.[1].messageId).toBe(9);
    });
  });
});
