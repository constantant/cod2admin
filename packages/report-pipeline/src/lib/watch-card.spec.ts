import { describe, expect, it, vi } from 'vitest';
import type { CardSender } from './pipeline.js';
import type { ReportCard } from './report-card.js';
import {
  buildWatchCard,
  processMachineReport,
  type MachineReport,
} from './watch-card.js';

function report(overrides: Partial<MachineReport> = {}): MachineReport {
  return {
    serverAlias: 'ctf',
    reporterName: 'AdminWatch',
    profileKey: 'guid:abc',
    target: { num: 3, name: 'Cheater', guid: 'abc' },
    reason: 'z=6.1, snap 12.0',
    disposition: 'flag',
    evidenceId: 'ev-1',
    ...overrides,
  };
}

describe('buildWatchCard', () => {
  it('uses a watch header and the same action rows', () => {
    const card = buildWatchCard({
      reporterName: 'AdminWatch',
      verb: 'flagged',
      target: { num: 3, name: 'Cheater', guid: 'abc' },
      reason: 'z=6.1, snap 12.0',
      connected: true,
    });
    expect(
      card.text.startsWith('Watch: AdminWatch flagged Cheater — z=6.1'),
    ).toBe(true);
    expect(card.buttons[0]?.map((button) => button.label)).toEqual([
      'Kick',
      'Temp Ban (30m)',
      'Ban',
    ]);
    expect(card.buttons[1]?.map((button) => button.label)).toEqual([
      'Ignore',
      'More info ▾',
    ]);
  });

  it('marks a kick card as not sent', () => {
    const card = buildWatchCard({
      reporterName: 'AdminWatch',
      verb: 'flagged a kick',
      target: { num: 3, name: 'Cheater' },
      reason: 'z=8.0',
      note: 'Kick was not sent.',
      connected: true,
    });
    expect(card.text).toContain('Kick was not sent.');
  });
});

describe('processMachineReport', () => {
  it('sends nothing and does not throw when no admin chat is bound', async () => {
    const send = vi.fn();
    const cardSender: CardSender<string> = {
      send,
      update: vi.fn(),
    };
    const outcome = await processMachineReport(report(), {
      chatId: null,
      cardSender,
    });
    expect(outcome).toEqual({});
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a flag card without a player-report hook', async () => {
    const send = vi.fn(async (_chatId: number, _card: ReportCard) => 'card-1');
    const outcome = await processMachineReport(report(), {
      chatId: -100,
      cardSender: { send, update: vi.fn() },
    });
    expect(outcome.cardRef).toBe('card-1');
    expect(send).toHaveBeenCalledOnce();
    const sent = send.mock.calls[0];
    if (!sent) throw new Error('expected a card');
    expect(sent[1].text).toContain('flagged Cheater');
  });
});
