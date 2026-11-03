import type { AdminStore, Report, ReportStatus } from '@cod2admin/admin-store';
import type { ReportTrigger } from '@cod2admin/log-tailer';

export type ReportQueueEvent =
  { kind: 'new'; report: Report } | { kind: 'resolved'; report: Report };

/**
 * The durable side of `!report` (docs/PLAN-miniapp.md §6.4): every report is saved here, whether or
 * not a chat is bound or Telegram is reachable, and whoever closes it — a card's button or the Mini
 * App — closes it for both. Open apps get told through `subscribe`.
 */
export class ReportQueue {
  private readonly listeners = new Set<(event: ReportQueueEvent) => void>();

  constructor(
    private readonly store: Pick<AdminStore, 'recordReport' | 'resolveReport'>,
  ) {}

  subscribe(listener: (event: ReportQueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async record(serverAlias: string, trigger: ReportTrigger): Promise<Report> {
    const { guid, name } = trigger.chat;
    const report = await this.store.recordReport({
      serverAlias,
      reporterName: name,
      reporterGuid: guid && guid !== '0' ? guid : null,
      targetName: trigger.targetName,
      reason: trigger.reason ?? null,
    });
    this.emit({ kind: 'new', report });
    return report;
  }

  /** `undefined` if it's gone or someone closed it first. */
  async resolve(
    id: number,
    resolution: {
      status: Exclude<ReportStatus, 'open'>;
      resolvedBy: number;
      outcome?: string | null;
    },
  ): Promise<Report | undefined> {
    const report = await this.store.resolveReport(id, resolution);
    if (report) {
      this.emit({ kind: 'resolved', report });
    }
    return report;
  }

  private emit(event: ReportQueueEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
