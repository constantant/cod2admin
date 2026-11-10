import type { ReportCard } from './report-card.js';
import type { CardSender } from './pipeline.js';

export interface WatchCardTarget {
  num: number;
  name: string;
  guid?: string;
  ip?: string;
}

/**
 * What the parent asks the card layer to show. `flag` does not enter the
 * player-report queue. This is not a chat line.
 */
export interface MachineReport {
  serverAlias: string;
  /** Display only. Not a connected slot. */
  reporterName: string;
  profileKey: string;
  target: WatchCardTarget;
  reason: string;
  disposition: 'flag' | 'report' | 'kick';
  evidenceId: string;
  /** Set when a queue row was written, so closing one closes the other. */
  queueId?: number;
  /** False: the target is gone, so the card only offers Ignore. */
  connected?: boolean;
}

/** Registry value for a watch card. No chat event and no anti-spam slot. */
export interface WatchCardEntry {
  origin: 'watch';
  chatId: number;
  messageId: number;
  serverAlias: string;
  evidenceId: string;
  profileKey: string;
  target: WatchCardTarget;
  detailText?: string;
  queueId?: number;
}

export interface WatchCardInput {
  reporterName: string;
  /** `flagged`, `reported`, or `flagged a kick`. */
  verb: string;
  target: WatchCardTarget;
  reason: string;
  note?: string;
  connected: boolean;
  detailText?: string;
}

const IGNORE_BUTTON = {
  label: 'Ignore',
  action: { kind: 'ignore' as const },
};

/**
 * Same action rows as a player card. The header is the watcher's, not a
 * forged `!report` line.
 */
export function buildWatchCard(input: WatchCardInput): ReportCard {
  const name = input.target.name || `client ${input.target.num}`;
  const lines = [
    `Watch: ${input.reporterName} ${input.verb} ${name} — ${input.reason}`,
    '',
    `Target: #${input.target.num} ${name}`,
  ];
  if (input.target.guid) {
    lines.push(`GUID: ${input.target.guid}`);
  }
  if (input.note) {
    lines.push('', input.note);
  }
  const detailText = input.detailText;
  if (!input.connected) {
    return {
      text: `${lines.join('\n')}\n\n⚠️ Target disconnected before this could be resolved live.`,
      buttons: [[IGNORE_BUTTON]],
      detailText,
    };
  }
  return {
    text: lines.join('\n'),
    buttons: [
      [
        { label: 'Kick', action: { kind: 'kick' } },
        { label: 'Temp Ban (30m)', action: { kind: 'tempban' } },
        { label: 'Ban', action: { kind: 'ban' } },
      ],
      [IGNORE_BUTTON, { label: 'More info ▾', action: { kind: 'more-info' } }],
    ],
    detailText,
  };
}

export interface ProcessMachineReportDeps<TCardRef> {
  cardSender: CardSender<TCardRef>;
  /** Null: nothing is sent. Callers still keep the evidence row. */
  chatId: number | null;
}

/**
 * Sends a watch card. No `ReportAntiSpam` and no chat event: a machine
 * report must not spend a player's flood slot.
 */
export async function processMachineReport<TCardRef>(
  report: MachineReport,
  deps: ProcessMachineReportDeps<TCardRef>,
): Promise<{ cardRef?: TCardRef }> {
  if (deps.chatId === null) {
    return {};
  }
  const verb =
    report.disposition === 'report'
      ? 'reported'
      : report.disposition === 'kick'
        ? 'flagged a kick'
        : 'flagged';
  const card = buildWatchCard({
    reporterName: report.reporterName,
    verb,
    target: report.target,
    reason: report.reason,
    // Kick execution is a later change. This card is the review, not the drop.
    note: report.disposition === 'kick' ? 'Kick was not sent.' : undefined,
    connected: report.connected !== false,
    detailText: report.reason,
  });
  const cardRef = await deps.cardSender.send(deps.chatId, card);
  return { cardRef };
}
