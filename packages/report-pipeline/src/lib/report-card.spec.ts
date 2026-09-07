import { describe, expect, it } from 'vitest';
import type { ChatEvent, ReportTrigger } from '@cod2admin/log-tailer';
import type { StatusPlayer } from '@cod2admin/rcon-client';
import type { EnrichedReport } from './enrichment.js';
import { buildAmbiguousReportCard, buildNotFoundReportCard, buildReportCard, formatDuration } from './report-card.js';

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

function enrichedReport(overrides: Partial<EnrichedReport['target']> = {}): EnrichedReport {
  return {
    target: { num: 1, name: 'Cheatr123', guid: 'realguid', ip: '1.2.3.4', ping: 40, score: 5, connected: true, sessionDurationMs: 65_000, chatHistory: [], ...overrides },
    reporter: { num: 9, name: 'Reporter', guid: '0' },
    history: { auditLog: [], bans: [], ipBans: [] },
  };
}

describe('formatDuration', () => {
  it('formats seconds only under a minute', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(65_000)).toBe('1m 05s');
  });

  it('formats hours and minutes (drops seconds)', () => {
    expect(formatDuration(3_725_000)).toBe('1h 02m');
  });

  it('clamps negative durations to 0', () => {
    expect(formatDuration(-500)).toBe('0s');
  });
});

describe('buildReportCard', () => {
  it('includes the header, target info, and full action buttons for a connected target', () => {
    const card = buildReportCard(enrichedReport(), trigger());

    expect(card.text).toContain('🚨 Report: Reporter reported Cheatr123 — aimbot');
    expect(card.text).toContain('Target: #1 Cheatr123');
    expect(card.text).toContain('IP: 1.2.3.4');
    expect(card.text).toContain('Session: 1m 05s so far');
    expect(card.buttons).toEqual([
      [
        { label: 'Kick', action: { kind: 'kick' } },
        { label: 'Temp Ban (30m)', action: { kind: 'tempban' } },
        { label: 'Ban', action: { kind: 'ban' } },
      ],
      [
        { label: 'Ignore', action: { kind: 'ignore' } },
        { label: 'More info ▾', action: { kind: 'more-info' } },
      ],
    ]);
  });

  it('flags an unavailable (0) GUID', () => {
    const card = buildReportCard(enrichedReport({ guid: '0' }), trigger());
    expect(card.text).toContain('GUID: 0 (unavailable');
  });

  it('includes a detailText with the full (untrimmed) chat history for More info', () => {
    const chatHistory = ['one', 'two', 'three', 'four'].map((message) => chatEvent({ message }));
    const card = buildReportCard(enrichedReport({ chatHistory, guid: 'realguid', ip: '9.9.9.9' }), trigger());

    expect(card.detailText).toContain('Full GUID: realguid');
    expect(card.detailText).toContain('Full IP: 9.9.9.9');
    expect(card.detailText).toContain('"one"');
    expect(card.detailText).toContain('"four"');
  });

  it('gives a disconnected target only an Ignore button and no IP/ping/score line', () => {
    const disconnected = enrichedReport({ connected: false, ip: undefined, ping: undefined, score: undefined, sessionDurationMs: 120_000 });
    const card = buildReportCard(disconnected, trigger());

    expect(card.text).toContain('⚠️ Target disconnected');
    expect(card.text).not.toContain('IP:');
    expect(card.text).toContain('Session: 2m 00s (ended)');
    expect(card.buttons).toEqual([[{ label: 'Ignore', action: { kind: 'ignore' } }]]);
  });

  it('reports prior action/ban counts from history', () => {
    const withHistory: EnrichedReport = {
      ...enrichedReport(),
      history: {
        auditLog: [{ id: 1, actorTelegramId: 1, action: 'kick', target: 'Cheatr123', serverAlias: 'default', reason: null, source: 'telegram_command', detailJson: null, createdAt: new Date() }],
        bans: [],
        ipBans: [{ id: 1, serverAlias: 'default', ip: '1.2.3.4', reason: null, bannedBy: 1, bannedAt: new Date(), expiresAt: null, unbannedAt: null }],
      },
    };

    const card = buildReportCard(withHistory, trigger());

    expect(card.text).toContain('Prior actions on record: 1');
    expect(card.text).toContain('Prior bans on record: 1');
  });

  it('shows only the last 3 chat lines', () => {
    const chatHistory = ['one', 'two', 'three', 'four'].map((message) => chatEvent({ message }));
    const card = buildReportCard(enrichedReport({ chatHistory }), trigger());

    expect(card.text).toContain('Recent chat: "two" / "three" / "four"');
  });

  it('falls back to a client-number label when the reporter name is empty', () => {
    const card = buildReportCard(enrichedReport(), trigger({ chat: chatEvent({ name: '', num: 4 }) }));
    expect(card.text).toContain('🚨 Report: client 4 reported Cheatr123');
  });
});

describe('buildAmbiguousReportCard', () => {
  it('renders one Select button per row, plus Ignore', () => {
    const candidates = [statusPlayer({ num: 1, name: 'Bobby' }), statusPlayer({ num: 2, name: 'BobTheBuilder' })];
    const card = buildAmbiguousReportCard(trigger({ targetName: 'bob' }), candidates);

    expect(card.text).toContain('Multiple players match "bob"');
    expect(card.buttons).toEqual([
      [{ label: 'Select: Bobby', action: { kind: 'select', candidateNum: 1 } }],
      [{ label: 'Select: BobTheBuilder', action: { kind: 'select', candidateNum: 2 } }],
      [{ label: 'Ignore', action: { kind: 'ignore' } }],
    ]);
  });
});

describe('buildNotFoundReportCard', () => {
  it('renders a not-found notice with only Ignore', () => {
    const card = buildNotFoundReportCard(trigger({ targetName: 'GhostPlayer' }));

    expect(card.text).toContain('No player matching "GhostPlayer"');
    expect(card.buttons).toEqual([[{ label: 'Ignore', action: { kind: 'ignore' } }]]);
  });
});
