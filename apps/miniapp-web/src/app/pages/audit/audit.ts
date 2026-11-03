import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import type { AuditEntryDto, AuditSourceDto } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { SessionService } from '../../core/session';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';

const SOURCE_LABELS: Record<AuditSourceDto, string> = {
  telegram_command: 'Chat command',
  telegram_button: 'Chat button',
  miniapp: 'App',
  auto: 'Automatic',
};

/** Who did what (docs/PLAN-miniapp.md §6.4) — `/auditlog`, searchable. Owner only, as in chat. */
@Component({
  selector: 'c2a-audit-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    Icon,
  ],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <div class="page">
      <mat-form-field
        class="full-width"
        subscriptSizing="dynamic"
        appearance="outline"
      >
        <c2a-icon matPrefix name="search" class="prefix" />
        <input
          matInput
          placeholder="Target or reason"
          [ngModel]="query()"
          (ngModelChange)="query.set($event)"
        />
      </mat-form-field>
      <div class="filters">
        <mat-form-field subscriptSizing="dynamic" appearance="outline">
          <mat-label>Action</mat-label>
          <mat-select [value]="action()" (valueChange)="action.set($event)">
            <mat-option value="">All</mat-option>
            @for (name of actions(); track name) {
              <mat-option [value]="name">{{ name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field subscriptSizing="dynamic" appearance="outline">
          <mat-label>From</mat-label>
          <mat-select [value]="source()" (valueChange)="source.set($event)">
            <mat-option value="">Anywhere</mat-option>
            @for (entry of sources; track entry.value) {
              <mat-option [value]="entry.value">{{ entry.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field subscriptSizing="dynamic" appearance="outline">
          <mat-label>Server</mat-label>
          <mat-select [value]="server()" (valueChange)="server.set($event)">
            <mat-option value="">All</mat-option>
            @for (entry of session.me()?.servers ?? []; track entry.alias) {
              <mat-option [value]="entry.alias">{{ entry.alias }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field subscriptSizing="dynamic" appearance="outline">
          <mat-label>Period</mat-label>
          <mat-select [value]="days()" (valueChange)="days.set($event)">
            <mat-option [value]="0">All time</mat-option>
            <mat-option [value]="1">24 hours</mat-option>
            <mat-option [value]="7">7 days</mat-option>
            <mat-option [value]="30">30 days</mat-option>
          </mat-select>
        </mat-form-field>
      </div>

      <ul class="entries">
        @for (entry of items(); track entry.id) {
          <li>
            <button class="entry" (click)="toggle(entry.id)">
              <span class="row">
                <span class="action">{{ entry.action }}</span>
                @if (entry.target) {
                  <span class="target">{{ entry.target }}</span>
                }
              </span>
              <span class="muted small">
                {{ entry.actor }} · {{ when(entry.at) }} ·
                {{ sourceLabel(entry.source) }}
                @if (entry.server) {
                  · {{ entry.server }}
                }
              </span>
              @if (entry.reason) {
                <span class="small">{{ entry.reason }}</span>
              }
            </button>
            @if (open() === entry.id && entry.detail) {
              <pre class="mono">{{ entry.detail }}</pre>
            }
          </li>
        } @empty {
          @if (!loading()) {
            <li class="empty">Nothing matches.</li>
          }
        }
      </ul>
      @if (more()) {
        <button mat-button class="full-width" (click)="load(true)">
          Show more
        </button>
      }
    </div>
  `,
  styles: `
    .prefix {
      margin: 0 4px 0 12px;
    }
    .filters {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 8px 0 12px;
    }
    .entries {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .entry {
      all: unset;
      display: flex;
      flex-direction: column;
      gap: 2px;
      width: 100%;
      padding: 8px 4px;
      box-sizing: border-box;
      cursor: pointer;
    }
    .entry:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
    }
    .action {
      font: var(--mat-sys-label-large);
    }
    .target {
      overflow-wrap: anywhere;
    }
    .small {
      font: var(--mat-sys-body-small);
      overflow-wrap: anywhere;
    }
    pre {
      margin: 0 0 8px;
      padding: 8px;
      border-radius: 8px;
      background: var(--mat-sys-surface-container);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
})
export class AuditPage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  protected readonly session = inject(SessionService);

  protected readonly sources = Object.entries(SOURCE_LABELS).map(
    ([value, label]) => ({ value, label }),
  );
  protected readonly items = signal<AuditEntryDto[]>([]);
  protected readonly actions = signal<string[]>([]);
  protected readonly query = signal('');
  protected readonly action = signal('');
  protected readonly source = signal('');
  protected readonly server = signal('');
  protected readonly days = signal(0);
  protected readonly loading = signal(false);
  protected readonly more = signal(false);
  protected readonly open = signal<number | null>(null);

  constructor() {
    effect(() => {
      this.query();
      this.action();
      this.source();
      this.server();
      this.days();
      untracked(() => void this.load());
    });
  }

  protected sourceLabel(source: AuditSourceDto): string {
    return SOURCE_LABELS[source];
  }

  protected when(iso: string): string {
    return new Date(iso).toLocaleString([], {
      dateStyle: 'short',
      timeStyle: 'short',
      hourCycle: 'h23',
    });
  }

  protected toggle(id: number): void {
    this.open.update((open) => (open === id ? null : id));
  }

  protected async load(append = false): Promise<void> {
    const filter = {
      q: this.query().trim(),
      action: this.action(),
      source: this.source(),
      server: this.server(),
      days: this.days() ? String(this.days()) : '',
    };
    this.loading.set(true);
    try {
      const page = await this.api.audit(
        filter,
        append ? this.items().length : 0,
      );
      this.actions.set(page.actions);
      this.items.update((items) =>
        append ? [...items, ...page.items] : page.items,
      );
      this.more.set(page.more);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }
}
