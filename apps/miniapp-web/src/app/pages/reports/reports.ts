import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { PlayerDto, ReportDto } from '@cod2admin/miniapp-api';
import { ApiService, toApiFailure } from '../../core/api';
import { LiveService } from '../../core/live';
import { flagEmoji, formatAgo } from '../../shared/format';
import { GameName } from '../../shared/game-name';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';
import { openPlayerSheet } from '../players/player-sheet';
import { T } from '../../shared/i18n';

/**
 * Players' `!report`s (docs/PLAN-miniapp.md §6.4), from every server, whether or not a Telegram chat
 * got a card. Closing one here closes its card, and the other way round.
 */
@Component({
  selector: 'c2a-reports-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
    MatButtonModule,
    MatButtonToggleModule,
    MatProgressBarModule,
    GameName,
    Icon,
  ],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <div class="page">
      <mat-button-toggle-group
        class="full-width tabs"
        hideSingleSelectionIndicator
        [aria-label]="'Which reports' | t"
        [value]="resolved()"
        (change)="resolved.set($event.value)"
      >
        <mat-button-toggle [value]="false">{{ 'Open' | t }}</mat-button-toggle>
        <mat-button-toggle [value]="true">{{ 'Closed' | t }}</mat-button-toggle>
      </mat-button-toggle-group>

      @for (report of items(); track report.id) {
        <section class="card report">
          <div class="row">
            <span class="target"><c2a-game-name [name]="report.target" /></span>
            @if (report.count > 1) {
              <span class="count">×{{ report.count }}</span>
            }
            <span class="spacer"></span>
            <span class="muted small">{{ ago(report.lastReportedAt) }}</span>
          </div>
          <div class="reason">
            {{ report.reason ?? ('No reason given' | t) }}
          </div>
          <div class="muted small">
            {{ 'from' | t }} <c2a-game-name [name]="report.reporter" /> ·
            {{ report.server }}
          </div>

          @if (report.status === 'open') {
            @if (report.candidates.length > 0) {
              <div class="candidates">
                @for (player of report.candidates; track player.num) {
                  <button
                    mat-stroked-button
                    (click)="openPlayer(report, player)"
                  >
                    <span>{{ flag(player) }}</span>
                    <c2a-game-name [name]="player.name" />
                  </button>
                }
              </div>
            } @else {
              <p class="muted small">
                {{ 'Nobody with that name is on now.' | t }}
              </p>
            }
            <div class="buttons">
              <button
                mat-button
                [disabled]="busy()"
                (click)="resolve(report, 'ignored')"
              >
                {{ 'Ignore' | t }}
              </button>
              <button
                mat-button
                [disabled]="busy()"
                (click)="resolve(report, 'handled')"
              >
                <c2a-icon name="check" /> {{ 'Mark handled' | t }}
              </button>
            </div>
          } @else {
            <p class="muted small">
              {{ report.outcome ?? report.status | t }}
              @if (report.resolvedBy) {
                {{ 'by' | t }} {{ report.resolvedBy }}
              }
              @if (report.resolvedAt) {
                · {{ ago(report.resolvedAt) }}
              }
            </p>
          }
        </section>
      } @empty {
        @if (!loading()) {
          <p class="empty">
            {{
              (resolved()
                ? 'No closed reports yet.'
                : 'No open reports. Players file them in game with !report.'
              ) | t
            }}
          </p>
        }
      }
      @if (more()) {
        <button mat-button class="full-width" (click)="loadMore()">
          {{ 'Show more' | t }}
        </button>
      }
    </div>
  `,
  styles: `
    .tabs {
      margin-bottom: 12px;
      mat-button-toggle {
        flex: 1;
      }
    }
    .report {
      margin-bottom: 10px;
    }
    .target {
      font: var(--mat-sys-title-medium);
      overflow-wrap: anywhere;
    }
    .count {
      font: var(--mat-sys-label-medium);
      padding: 0 6px;
      border-radius: 8px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    .reason {
      margin: 4px 0;
      overflow-wrap: anywhere;
    }
    .small {
      font: var(--mat-sys-body-small);
    }
    p.small {
      margin: 8px 0 0;
    }
    .candidates {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .buttons {
      display: flex;
      justify-content: flex-end;
      margin-top: 4px;
    }
  `,
})
export class ReportsPage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  private readonly sheet = inject(MatBottomSheet);
  private readonly live = inject(LiveService);

  protected readonly items = signal<ReportDto[]>([]);
  protected readonly resolved = signal(false);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly more = signal(false);

  constructor() {
    // Also when one arrives or someone else closes one (`openReports` changes), and on reconnect.
    effect(() => {
      const resolved = this.resolved();
      this.live.openReports();
      this.live.generation();
      untracked(() => void this.load(resolved));
    });
  }

  protected ago(iso: string): string {
    return formatAgo(iso);
  }

  protected flag(player: PlayerDto): string {
    return flagEmoji(player.countryCode);
  }

  private async load(resolved: boolean): Promise<void> {
    this.loading.set(true);
    try {
      const page = await this.api.reports(resolved, 0);
      if (resolved === this.resolved()) {
        this.items.set(page.items);
        this.more.set(page.more);
      }
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected async loadMore(): Promise<void> {
    try {
      const page = await this.api.reports(this.resolved(), this.items().length);
      this.items.update((items) => [...items, ...page.items]);
      this.more.set(page.more);
    } catch (error) {
      this.notify.error(error);
    }
  }

  protected openPlayer(report: ReportDto, player: PlayerDto): void {
    openPlayerSheet(this.sheet, { server: report.server, player })
      .afterDismissed()
      .subscribe(async (acted) => {
        if (!acted) {
          return;
        }
        // Acting may not settle it (a warning message, say), so ask rather than assume.
        const close = await this.notify.confirm({
          title: 'Close this report?',
          message: `Mark the report on ${report.target} as handled.`,
          confirm: 'Mark handled',
        });
        if (close) {
          await this.resolve(report, 'handled');
        }
      });
  }

  protected async resolve(
    report: ReportDto,
    status: 'handled' | 'ignored',
  ): Promise<void> {
    this.busy.set(true);
    try {
      this.notify.success(
        (await this.api.resolveReport(report.id, { status })).message,
      );
    } catch (error) {
      if (toApiFailure(error).status === 409) {
        this.notify.info(toApiFailure(error).message);
      } else {
        this.notify.error(error);
        return;
      }
    } finally {
      this.busy.set(false);
    }
    this.items.update((items) => items.filter((item) => item.id !== report.id));
  }
}
