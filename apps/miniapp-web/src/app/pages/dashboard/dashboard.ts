import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { DashboardResponse } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { LiveService } from '../../core/live';
import { SessionService } from '../../core/session';
import { GameName } from '../../shared/game-name';
import { Icon } from '../../shared/icon';
import { LineChart } from '../../shared/line-chart';
import { Notify } from '../../shared/notify';
import { modeLabel } from '../maps/maps';

/** The server at a glance, and how busy it has been (docs/PLAN-miniapp.md §6.4). */
@Component({
  selector: 'c2a-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MatButtonModule,
    MatButtonToggleModule,
    MatProgressBarModule,
    GameName,
    Icon,
    LineChart,
  ],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <div class="page">
      @if (data(); as data) {
        <section class="card">
          <div class="row">
            <span class="state" [class.on]="data.online">{{
              data.online ? 'Online' : 'Offline'
            }}</span>
            <span class="spacer"></span>
            <button
              mat-icon-button
              aria-label="Reload"
              [disabled]="loading()"
              (click)="load()"
            >
              <c2a-icon name="refresh" />
            </button>
          </div>
          @if (data.hostname) {
            <div class="hostname"><c2a-game-name [name]="data.hostname" /></div>
          }
          <div class="tiles">
            <div>
              <div class="value">
                {{ players() }}
                @if (data.maxClients) {
                  <span class="of">/{{ data.maxClients }}</span>
                }
              </div>
              <div class="muted">players now</div>
            </div>
            <div>
              <div class="value text">{{ map() ?? '—' }}</div>
              <div class="muted">
                map{{ data.gametype ? ' · ' + mode(data.gametype) : '' }}
              </div>
            </div>
          </div>
        </section>

        <mat-button-toggle-group
          class="full-width range"
          hideSingleSelectionIndicator
          aria-label="Period"
          [value]="hours()"
          (change)="hours.set($event.value)"
        >
          <mat-button-toggle [value]="24">24 hours</mat-button-toggle>
          <mat-button-toggle [value]="168">7 days</mat-button-toggle>
          <mat-button-toggle [value]="720">30 days</mat-button-toggle>
        </mat-button-toggle-group>

        @if (data.history.samples === 0) {
          <p class="empty">
            No history for this period yet. The bot checks the server once a
            minute and keeps 30 days.
          </p>
        } @else {
          <section class="tiles three">
            <div class="card">
              <div class="value">{{ data.history.peak?.players ?? '—' }}</div>
              <div class="muted">peak</div>
            </div>
            <div class="card">
              <div class="value">{{ rounded(data.history.average) }}</div>
              <div class="muted">average</div>
            </div>
            <div class="card">
              <div class="value">{{ percent(data.history.uptimePercent) }}</div>
              <div class="muted">uptime</div>
            </div>
          </section>

          <section class="card chart">
            <div class="row">
              <h2>Players</h2>
              <span class="spacer"></span>
              <button mat-button (click)="table.set(!table())">
                {{ table() ? 'Chart' : 'Table' }}
              </button>
            </div>
            @if (table()) {
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th class="num">Players</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (point of data.history.points; track point.at) {
                      <tr>
                        <td>{{ time(point.at) }}</td>
                        <td class="num">{{ point.players ?? 'offline' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            } @else {
              <c2a-line-chart
                [points]="data.history.points"
                [since]="since()"
                [until]="until()"
                [label]="chartLabel()"
              />
            }
          </section>

          @if (data.history.topMaps.length > 0) {
            <section class="card">
              <h2>Most played</h2>
              <ul class="maps">
                @for (entry of data.history.topMaps; track entry.map) {
                  <li>
                    <div class="row">
                      <span class="map-name">{{ entry.map }}</span>
                      <span class="spacer"></span>
                      <span class="muted">{{ percent(entry.percent) }}</span>
                    </div>
                    <div class="bar" [style.width.%]="entry.percent"></div>
                  </li>
                }
              </ul>
              <p class="muted small">By time with at least one player on.</p>
            </section>
          }
        }

        @if (session.can('admin')) {
          <a mat-button routerLink="/settings">
            <c2a-icon name="tune" /> All server settings
          </a>
        }
      }
    </div>
  `,
  styles: `
    .card {
      margin-bottom: 12px;
    }
    .state {
      font: var(--mat-sys-label-large);
      color: var(--mat-sys-error);
      &.on {
        color: var(--mat-sys-primary);
      }
    }
    .hostname {
      font: var(--mat-sys-title-medium);
      margin-bottom: 8px;
      overflow-wrap: anywhere;
    }
    .tiles {
      display: grid;
      grid-template-columns: 1fr 2fr;
      gap: 12px;
      &.three {
        grid-template-columns: repeat(3, 1fr);
        .card {
          text-align: center;
          padding: 12px 8px;
        }
      }
    }
    .value {
      font: var(--mat-sys-headline-small);
      font-variant-numeric: tabular-nums;
      &.text {
        font: var(--mat-sys-title-medium);
        line-height: 32px;
        overflow-wrap: anywhere;
      }
    }
    .of {
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .range {
      margin-bottom: 12px;
      mat-button-toggle {
        flex: 1;
      }
    }
    h2 {
      font: var(--mat-sys-title-small);
      margin: 0;
    }
    .maps {
      list-style: none;
      margin: 8px 0 0;
      padding: 0;
      li {
        margin-bottom: 10px;
      }
    }
    .bar {
      height: 6px;
      margin-top: 4px;
      border-radius: 0 3px 3px 0;
      background: var(--mat-sys-primary);
    }
    .small {
      font: var(--mat-sys-body-small);
      margin: 0;
    }
    .table-wrap {
      max-height: 280px;
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      text-align: left;
      padding: 4px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      font: var(--mat-sys-body-small);
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class DashboardPage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  private readonly live = inject(LiveService);
  protected readonly session = inject(SessionService);

  protected readonly data = signal<DashboardResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly table = signal(false);
  protected readonly hours = signal(24);
  protected readonly until = signal(new Date().toISOString());
  protected readonly mode = modeLabel;
  protected readonly since = computed(() =>
    new Date(
      new Date(this.until()).getTime() - this.hours() * 3_600_000,
    ).toISOString(),
  );
  /** The live feed knows sooner than this page's last load. */
  protected readonly players = computed(
    () => this.live.status()?.players.length ?? this.data()?.players ?? 0,
  );
  protected readonly map = computed(
    () => this.live.status()?.mapName ?? this.data()?.map ?? null,
  );
  protected readonly chartLabel = computed(() => {
    const history = this.data()?.history;
    return `Players over the last ${this.hours()} hours, peak ${history?.peak?.players ?? 0}, average ${this.rounded(history?.average ?? null)}`;
  });

  constructor() {
    effect(() => {
      const alias = this.session.server();
      const hours = this.hours();
      untracked(() => void this.load(alias, hours));
    });
  }

  protected rounded(value: number | null): string {
    return value === null ? '—' : String(Math.round(value * 10) / 10);
  }

  protected percent(value: number | null): string {
    return value === null ? '—' : `${Math.round(value)}%`;
  }

  protected time(iso: string): string {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }

  protected async load(
    alias = this.session.server(),
    hours = this.hours(),
  ): Promise<void> {
    this.loading.set(true);
    try {
      const data = await this.api.dashboard(alias, hours);
      if (alias === this.session.server() && hours === this.hours()) {
        this.until.set(new Date().toISOString());
        this.data.set(data);
      }
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }
}
