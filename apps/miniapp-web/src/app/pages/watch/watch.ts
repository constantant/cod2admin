import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { WatchEvidenceDto } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { SessionService } from '../../core/session';
import { formatAgo } from '../../shared/format';
import { Notify } from '../../shared/notify';
import { T } from '../../shared/i18n';

/** Stored watch decisions for the selected server. The angle window is often empty. */
@Component({
  selector: 'c2a-watch-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [T, MatButtonModule, MatProgressBarModule],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <div class="page">
      <h2>{{ 'Watch evidence' | t }}</h2>
      <p class="muted small">
        {{
          'Scores and reasons the watcher stored for this server. The angle window is empty until a later change sends one.'
            | t
        }}
      </p>
      @for (row of items(); track row.id) {
        <section class="card evidence">
          <div class="row">
            <span class="action">{{ row.action }}</span>
            <span class="spacer"></span>
            <span class="muted small">{{ ago(row.createdAt) }}</span>
          </div>
          <div class="small">
            {{ 'Life score' | t }} {{ score(row.lifeScore) }}
            @if (row.reason) {
              · {{ row.reason }}
            }
          </div>
          <div class="small">
            <span class="muted">{{ 'Profile' | t }}</span>
            <span class="mono">{{ row.profileKey }}</span>
          </div>
          @if (featureLine(row); as line) {
            <div class="small mono">{{ line }}</div>
          }
          @if (row.trace === null || row.trace === undefined) {
            <p class="muted small trace">{{ 'No angle trace stored.' | t }}</p>
          } @else {
            <pre class="mono">{{ traceJson(row.trace) }}</pre>
          }
        </section>
      } @empty {
        @if (!loading()) {
          <p class="empty">
            {{ 'No watch evidence on this server yet.' | t }}
          </p>
        }
      }
      @if (more()) {
        <button
          mat-button
          class="full-width"
          (click)="load(session.server(), true)"
        >
          {{ 'Show more' | t }}
        </button>
      }
    </div>
  `,
  styles: `
    h2 {
      margin: 0 0 8px;
      font: var(--mat-sys-title-medium);
    }
    .small {
      font: var(--mat-sys-body-small);
      overflow-wrap: anywhere;
    }
    .evidence {
      margin-bottom: 10px;
    }
    .action {
      font: var(--mat-sys-label-large);
    }
    .trace {
      margin: 8px 0 0;
    }
    pre {
      margin: 8px 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
})
export class WatchPage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  protected readonly session = inject(SessionService);

  protected readonly items = signal<WatchEvidenceDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly more = signal(false);

  constructor() {
    effect(() => {
      const alias = this.session.server();
      untracked(() => {
        this.items.set([]);
        this.more.set(false);
        void this.load(alias);
      });
    });
  }

  protected ago(iso: string): string {
    return formatAgo(iso);
  }

  protected score(value: number): string {
    if (!Number.isFinite(value)) return '';
    return String(Math.round(value * 100) / 100);
  }

  protected featureLine(row: WatchEvidenceDto): string {
    return Object.entries(row.features)
      .filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      )
      .map(([name, value]) => `${name} ${this.score(value)}`)
      .join(' · ');
  }

  /** Whatever was stored. Null is rendered by the template, not replaced. */
  protected traceJson(trace: unknown): string {
    return JSON.stringify(trace, null, 2) ?? '';
  }

  protected async load(
    alias = this.session.server(),
    append = false,
  ): Promise<void> {
    if (!alias) return;
    this.loading.set(true);
    try {
      const page = await this.api.watchEvidence(
        alias,
        append ? this.items().length : 0,
      );
      if (alias !== this.session.server()) return;
      this.items.update((items) =>
        append ? [...items, ...page.items] : page.items,
      );
      this.more.set(page.more);
    } catch (error) {
      if (alias === this.session.server()) this.notify.error(error);
    } finally {
      if (alias === this.session.server()) this.loading.set(false);
    }
  }
}
