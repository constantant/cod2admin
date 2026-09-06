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
    expect(fakeTailerInstances[0].on).toHaveBeenCalledWith('reportTrigger', expect.any(Function));
    expect(fakeTailerInstances[0].on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(deps.sessionsByServer.get('default')).toBe(fakeTailerInstances[0]);
  });

  it('skips a server with no log path configured', () => {
    const { deps } = createFakeDeps();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const tailers = startReportTailers([serverConfig({ logSourceConfig: null })], deps, {} as never);

    expect(tailers).toHaveLength(0);
    expect(fakeTailerInstances).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no log path configured'));
    warn.mockRestore();
  });

  it('skips a server with no bound Telegram chat', () => {
    const { deps } = createFakeDeps();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const tailers = startReportTailers([serverConfig({ boundTelegramChatId: null })], deps, {} as never);

    expect(tailers).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no bound Telegram chat'));
    warn.mockRestore();
  });

  it('skips a server whose alias has no matching rconClients entry', () => {
    const { deps } = createFakeDeps();

    const tailers = startReportTailers([serverConfig({ alias: 'unknown-server' })], deps, {} as never);

    expect(tailers).toHaveLength(0);
  });

  it('starts one tailer per qualifying server, independently', () => {
    const { deps } = createFakeDeps();
    deps.rconClients.set('second', deps.rconClients.get('default')!);

    const tailers = startReportTailers(
      [serverConfig({ alias: 'default' }), serverConfig({ alias: 'second', boundTelegramChatId: 777 })],
      deps,
      {} as never,
    );

    expect(tailers).toHaveLength(2);
    expect(deps.sessionsByServer.has('default')).toBe(true);
    expect(deps.sessionsByServer.has('second')).toBe(true);
  });

  it("calls handleReportTrigger when the tailer's reportTrigger event fires", async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.status.mockResolvedValue({ raw: '', players: [] });

    startReportTailers([serverConfig()], deps, { api: { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) } } as never);

    const trigger = {
      chat: { channel: 'say' as const, guid: '0', num: 1, name: 'Reporter', message: '!report X', timestamp: { minutes: 0, seconds: 0 }, raw: '' },
      targetName: 'X',
    };
    const reportTriggerListener = fakeTailerInstances[0].listeners['reportTrigger'][0];
    reportTriggerListener(trigger);

    // handleReportTrigger is async and fire-and-forget from the listener - give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rcon.status).toHaveBeenCalled();
  });
});
