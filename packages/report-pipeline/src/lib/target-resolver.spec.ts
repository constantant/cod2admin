import { describe, expect, it, vi } from 'vitest';
import type { PlayerSession } from '@cod2admin/log-tailer';
import type { ServerStatus, StatusPlayer } from '@cod2admin/rcon-client';
import { resolveReportTarget } from './target-resolver.js';

function statusPlayer(overrides: Partial<StatusPlayer> = {}): StatusPlayer {
  return { num: 0, score: 0, ping: 42, name: 'Player', ...overrides };
}

function playerSession(overrides: Partial<PlayerSession> = {}): PlayerSession {
  return { num: 0, guid: '0', name: 'Player', connectedAt: 0, chatHistory: [], ...overrides };
}

function fakeRcon(players: StatusPlayer[]): { status: () => Promise<ServerStatus> } {
  return { status: vi.fn().mockResolvedValue({ raw: '', players }) };
}

function fakeSessions(sessions: PlayerSession[]): { listSessions: () => PlayerSession[] } {
  return { listSessions: () => sessions };
}

describe('resolveReportTarget', () => {
  it('resolves to the single live match from status()', async () => {
    const rcon = fakeRcon([statusPlayer({ num: 1, name: 'Cheatr123' }), statusPlayer({ num: 2, name: 'Innocent' })]);
    const result = await resolveReportTarget('Cheatr123', { rcon, sessions: fakeSessions([]) });

    expect(result).toEqual({ kind: 'resolved', player: statusPlayer({ num: 1, name: 'Cheatr123' }) });
    expect(rcon.status).toHaveBeenCalledTimes(1);
  });

  it('returns ambiguous candidates for a partial name matching multiple live players', async () => {
    const bobby = statusPlayer({ num: 1, name: 'Bobby' });
    const bobTheBuilder = statusPlayer({ num: 2, name: 'BobTheBuilder' });
    const rcon = fakeRcon([bobby, bobTheBuilder, statusPlayer({ num: 3, name: 'Alice' })]);

    const result = await resolveReportTarget('bob', { rcon, sessions: fakeSessions([]) });

    expect(result).toEqual({ kind: 'ambiguous', candidates: [bobby, bobTheBuilder] });
  });

  it('falls back to a cached (disconnected) session when there is no live match, without a second status() call', async () => {
    const rcon = fakeRcon([statusPlayer({ num: 1, name: 'SomeoneElse' })]);
    const disconnected = playerSession({ num: 2, name: 'Cheatr123', disconnectedAt: 5_000 });

    const result = await resolveReportTarget('Cheatr123', { rcon, sessions: fakeSessions([disconnected]) });

    expect(result).toEqual({ kind: 'disconnected', lastKnown: disconnected });
    expect(rcon.status).toHaveBeenCalledTimes(1);
  });

  it('prefers the most recently active cached session when a name matches more than one', async () => {
    const rcon = fakeRcon([]);
    const older = playerSession({ num: 1, name: 'Cheatr123', connectedAt: 0, disconnectedAt: 1_000 });
    const newer = playerSession({ num: 2, name: 'Cheatr123', connectedAt: 2_000, disconnectedAt: 3_000 });

    const result = await resolveReportTarget('Cheatr123', { rcon, sessions: fakeSessions([older, newer]) });

    expect(result).toEqual({ kind: 'disconnected', lastKnown: newer });
  });

  it('returns not-found when nothing matches live or cached state', async () => {
    const rcon = fakeRcon([statusPlayer({ name: 'SomeoneElse' })]);
    const result = await resolveReportTarget('NoSuchPlayer', { rcon, sessions: fakeSessions([]) });

    expect(result).toEqual({ kind: 'not-found' });
  });
});
