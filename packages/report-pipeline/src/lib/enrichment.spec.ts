import { describe, expect, it, vi } from 'vitest';
import type { AuditLogEntry } from '@cod2admin/admin-store';
import type { Ban, BanIp } from '@cod2admin/ban-store';
import type { ChatEvent, PlayerSession, ReportTrigger } from '@cod2admin/log-tailer';
import type { StatusPlayer } from '@cod2admin/rcon-client';
import { enrichReport } from './enrichment.js';
import type { ResolvedTarget } from './target-resolver.js';

function chatEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    channel: 'say',
    guid: '0',
    num: 9,
    name: 'Reporter',
    message: '!report Cheatr123 aimbot',
    timestamp: { minutes: 1, seconds: 0 },
    raw: '',
    ...overrides,
  };
}

function trigger(overrides: Partial<ReportTrigger> = {}): ReportTrigger {
  return { chat: chatEvent(), targetName: 'Cheatr123', reason: 'aimbot', ...overrides };
}

function statusPlayer(overrides: Partial<StatusPlayer> = {}): StatusPlayer {
  return { num: 1, score: 5, ping: 40, name: 'Cheatr123', ...overrides };
}

function playerSession(overrides: Partial<PlayerSession> = {}): PlayerSession {
  return { num: 1, guid: '0', name: 'Cheatr123', connectedAt: 0, chatHistory: [], ...overrides };
}

function fakeDeps(overrides: {
  session?: PlayerSession;
  auditLog?: AuditLogEntry[];
  bans?: Ban[];
  ipBans?: BanIp[];
} = {}) {
  return {
    sessions: { getSession: vi.fn().mockReturnValue(overrides.session) },
    adminStore: { listAuditLogForTarget: vi.fn().mockResolvedValue(overrides.auditLog ?? []) },
    banStore: {
      listBansByGuid: vi.fn().mockResolvedValue(overrides.bans ?? []),
      listBansByName: vi.fn().mockResolvedValue(overrides.bans ?? []),
      listIpBansByIp: vi.fn().mockResolvedValue(overrides.ipBans ?? []),
    },
    serverAlias: 'default',
  };
}

describe('enrichReport', () => {
  it('enriches a live (resolved) target with status() fields plus log-tailer session state', async () => {
    const resolution: ResolvedTarget = { kind: 'resolved', player: statusPlayer({ guid: 'realguid', ip: '1.2.3.4' }) };
    const session = playerSession({ guid: 'realguid', connectedAt: 1_000, chatHistory: [chatEvent({ message: 'hi' })] });
    const deps = fakeDeps({ session });

    const result = await enrichReport(resolution, trigger(), deps);

    expect(result.target).toMatchObject({
      num: 1,
      name: 'Cheatr123',
      guid: 'realguid',
      ip: '1.2.3.4',
      ping: 40,
      score: 5,
      connected: true,
    });
    expect(result.target.chatHistory).toEqual([chatEvent({ message: 'hi' })]);
    expect(deps.sessions.getSession).toHaveBeenCalledWith(1);
  });

  it('enriches a disconnected target entirely from the cached session (no ip/ping/score available)', async () => {
    const session = playerSession({ disconnectedAt: 5_000, connectedAt: 1_000, chatHistory: [chatEvent()] });
    const resolution: ResolvedTarget = { kind: 'disconnected', lastKnown: session };
    const deps = fakeDeps();

    const result = await enrichReport(resolution, trigger(), deps);

    expect(result.target).toMatchObject({ num: 1, name: 'Cheatr123', connected: false, sessionDurationMs: 4_000 });
    expect(result.target.ip).toBeUndefined();
    expect(result.target.chatHistory).toEqual([chatEvent()]);
  });

  it('includes the reporter straight from the trigger\'s chat line, no extra lookups', async () => {
    const resolution: ResolvedTarget = { kind: 'resolved', player: statusPlayer() };
    const deps = fakeDeps();

    const result = await enrichReport(resolution, trigger({ chat: chatEvent({ num: 3, name: 'Snitch', guid: 'r-guid' }) }), deps);

    expect(result.reporter).toEqual({ num: 3, name: 'Snitch', guid: 'r-guid' });
  });

  it('queries ban history by GUID when the target has a usable (non-zero) GUID', async () => {
    const resolution: ResolvedTarget = { kind: 'resolved', player: statusPlayer({ guid: 'realguid' }) };
    const deps = fakeDeps();

    await enrichReport(resolution, trigger(), deps);

    expect(deps.banStore.listBansByGuid).toHaveBeenCalledWith('default', 'realguid', 10);
    expect(deps.banStore.listBansByName).not.toHaveBeenCalled();
  });

  it('falls back to name-based ban history when GUID is "0" (§2.4)', async () => {
    const resolution: ResolvedTarget = { kind: 'resolved', player: statusPlayer({ guid: '0' }) };
    const deps = fakeDeps();

    await enrichReport(resolution, trigger(), deps);

    expect(deps.banStore.listBansByName).toHaveBeenCalledWith('default', 'Cheatr123', 10);
    expect(deps.banStore.listBansByGuid).not.toHaveBeenCalled();
  });

  it('falls back to name-based ban history when GUID is entirely absent (the disconnected case can lack it too)', async () => {
    const resolution: ResolvedTarget = { kind: 'disconnected', lastKnown: playerSession({ guid: '0' }) };
    const deps = fakeDeps();

    await enrichReport(resolution, trigger(), deps);

    expect(deps.banStore.listBansByName).toHaveBeenCalledWith('default', 'Cheatr123', 10);
  });

  it('only queries IP-ban history when an IP is known (never for a disconnected target)', async () => {
    const live: ResolvedTarget = { kind: 'resolved', player: statusPlayer({ ip: '9.9.9.9' }) };
    const disconnected: ResolvedTarget = { kind: 'disconnected', lastKnown: playerSession() };

    const liveDeps = fakeDeps();
    await enrichReport(live, trigger(), liveDeps);
    expect(liveDeps.banStore.listIpBansByIp).toHaveBeenCalledWith('default', '9.9.9.9', 10);

    const disconnectedDeps = fakeDeps();
    await enrichReport(disconnected, trigger(), disconnectedDeps);
    expect(disconnectedDeps.banStore.listIpBansByIp).not.toHaveBeenCalled();
  });

  it('respects a custom historyLimit', async () => {
    const resolution: ResolvedTarget = { kind: 'resolved', player: statusPlayer({ guid: 'realguid' }) };
    const deps = fakeDeps();

    await enrichReport(resolution, trigger(), { ...deps, historyLimit: 3 });

    expect(deps.adminStore.listAuditLogForTarget).toHaveBeenCalledWith('default', 'Cheatr123', 3);
    expect(deps.banStore.listBansByGuid).toHaveBeenCalledWith('default', 'realguid', 3);
  });

  it('passes through history rows from both stores unchanged', async () => {
    const auditLog: AuditLogEntry[] = [
      { id: 1, actorTelegramId: 1, action: 'kick', target: 'Cheatr123', serverAlias: 'default', reason: null, source: 'telegram_command', detailJson: null, createdAt: new Date() },
    ];
    const bans: Ban[] = [
      { id: 1, serverAlias: 'default', guid: null, name: 'Cheatr123', reason: 'past offense', bannedBy: 1, bannedAt: new Date(), expiresAt: null },
    ];
    const resolution: ResolvedTarget = { kind: 'resolved', player: statusPlayer({ guid: '0' }) };
    const deps = fakeDeps({ auditLog, bans });

    const result = await enrichReport(resolution, trigger(), deps);

    expect(result.history.auditLog).toBe(auditLog);
    expect(result.history.bans).toBe(bans);
  });

  it('leaves sessionDurationMs undefined when log-tailer has no session for a live target (e.g. gateway restarted mid-session)', async () => {
    const resolution: ResolvedTarget = { kind: 'resolved', player: statusPlayer() };
    const deps = fakeDeps({ session: undefined });

    const result = await enrichReport(resolution, trigger(), deps);

    expect(result.target.sessionDurationMs).toBeUndefined();
    expect(result.target.chatHistory).toEqual([]);
  });
});
