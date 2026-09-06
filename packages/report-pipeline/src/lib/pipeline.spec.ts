import { describe, expect, it, vi } from 'vitest';
import type { ChatEvent, PlayerSession, ReportTrigger } from '@cod2admin/log-tailer';
import type { ServerStatus, StatusPlayer } from '@cod2admin/rcon-client';
import { ReportAntiSpam } from './anti-spam.js';
import { processReportTrigger, type CardSender, type ProcessReportTriggerDeps } from './pipeline.js';
import type { ReportCard } from './report-card.js';

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
  return { num: 1, score: 0, ping: 40, name: 'Cheatr123', ...overrides };
}

function playerSession(overrides: Partial<PlayerSession> = {}): PlayerSession {
  return { num: 1, guid: '0', name: 'Cheatr123', connectedAt: 0, chatHistory: [], ...overrides };
}

function fakeCardSender(): CardSender<string> & { send: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } {
  let nextId = 1;
  return {
    send: vi.fn(async () => `card-${nextId++}`),
    update: vi.fn(async () => undefined),
  };
}

function baseDeps(players: StatusPlayer[], sessions: PlayerSession[] = []): Omit<ProcessReportTriggerDeps<string>, 'antiSpam' | 'cardSender'> {
  const sessionByNum = new Map(sessions.map((s) => [s.num, s]));
  return {
    rcon: { status: vi.fn(async (): Promise<ServerStatus> => ({ raw: '', players })) },
    sessions: {
      getSession: (num: number) => sessionByNum.get(num),
      listSessions: () => sessions,
    },
    adminStore: { listAuditLogForTarget: vi.fn().mockResolvedValue([]) },
    banStore: {
      listBansByGuid: vi.fn().mockResolvedValue([]),
      listBansByName: vi.fn().mockResolvedValue([]),
      listIpBansByIp: vi.fn().mockResolvedValue([]),
    },
    serverAlias: 'default',
    chatId: 555,
  };
}

describe('processReportTrigger', () => {
  it('resolves, enriches, builds a full card, sends it, and tracks it for anti-spam', async () => {
    const cardSender = fakeCardSender();
    const antiSpam = new ReportAntiSpam<string>({ now: () => 0 });
    const deps: ProcessReportTriggerDeps<string> = { ...baseDeps([statusPlayer()]), antiSpam, cardSender };

    const outcome = await processReportTrigger(trigger(), deps);

    expect(outcome).toEqual({ kind: 'sent', cardRef: 'card-1' });
    expect(cardSender.send).toHaveBeenCalledTimes(1);
    const [chatId, card] = cardSender.send.mock.calls[0] as [number, ReportCard];
    expect(chatId).toBe(555);
    expect(card.buttons[0]).toEqual([
      { label: 'Kick', action: { kind: 'kick' } },
      { label: 'Temp Ban (30m)', action: { kind: 'tempban' } },
      { label: 'Ban', action: { kind: 'ban' } },
    ]);
    // Tracked, so an immediate repeat collapses instead of sending again.
    expect(antiSpam.check(9, 'Cheatr123')).toMatchObject({ reason: 'duplicate', existing: 'card-1' });
  });

  it('builds the ambiguous card and does not touch enrichment (admin/ban stores) for it', async () => {
    const cardSender = fakeCardSender();
    const antiSpam = new ReportAntiSpam<string>({ now: () => 0 });
    const deps = { ...baseDeps([statusPlayer({ num: 1, name: 'Bobby' }), statusPlayer({ num: 2, name: 'BobTheBuilder' })]), antiSpam, cardSender };

    const outcome = await processReportTrigger(trigger({ targetName: 'bob' }), deps);

    expect(outcome.kind).toBe('sent');
    const [, card] = cardSender.send.mock.calls[0] as [number, ReportCard];
    expect(card.text).toContain('Multiple players match "bob"');
    expect(deps.adminStore.listAuditLogForTarget).not.toHaveBeenCalled();
  });

  it('builds the not-found card when nothing matches live or cached state', async () => {
    const cardSender = fakeCardSender();
    const antiSpam = new ReportAntiSpam<string>({ now: () => 0 });
    const deps = { ...baseDeps([]), antiSpam, cardSender };

    await processReportTrigger(trigger({ targetName: 'NoSuchPlayer' }), deps);

    const [, card] = cardSender.send.mock.calls[0] as [number, ReportCard];
    expect(card.text).toContain('No player matching "NoSuchPlayer"');
  });

  it('builds the disconnected-target card via the cached session, with no live status match', async () => {
    const cardSender = fakeCardSender();
    const antiSpam = new ReportAntiSpam<string>({ now: () => 0 });
    const session = playerSession({ disconnectedAt: 5_000 });
    const deps = { ...baseDeps([], [session]), antiSpam, cardSender };

    await processReportTrigger(trigger(), deps);

    const [, card] = cardSender.send.mock.calls[0] as [number, ReportCard];
    expect(card.text).toContain('⚠️ Target disconnected');
  });

  it('skips everything and reports cooldown when the reporter is rate-limited', async () => {
    const cardSender = fakeCardSender();
    let clock = 0;
    const antiSpam = new ReportAntiSpam<string>({ cooldownMs: 60_000, now: () => clock });
    antiSpam.track(9, 'SomeoneElse', 'card-old');
    clock = 10_000;
    const deps = { ...baseDeps([statusPlayer()]), antiSpam, cardSender };

    const outcome = await processReportTrigger(trigger(), deps);

    expect(outcome).toEqual({ kind: 'cooldown', retryAfterMs: 50_000 });
    expect(cardSender.send).not.toHaveBeenCalled();
    expect(deps.rcon.status).not.toHaveBeenCalled();
  });

  it('updates the existing card instead of sending a new one for a duplicate report', async () => {
    const cardSender = fakeCardSender();
    let clock = 0;
    const antiSpam = new ReportAntiSpam<string>({ cooldownMs: 60_000, now: () => clock });
    antiSpam.track(9, 'Cheatr123', 'card-1');
    clock = 5_000;
    const deps = { ...baseDeps([statusPlayer()]), antiSpam, cardSender };

    const outcome = await processReportTrigger(trigger(), deps);

    expect(outcome).toEqual({ kind: 'updated', cardRef: 'card-1' });
    expect(cardSender.send).not.toHaveBeenCalled();
    expect(cardSender.update).toHaveBeenCalledWith('card-1', expect.objectContaining({ text: expect.any(String) }));
  });
});
