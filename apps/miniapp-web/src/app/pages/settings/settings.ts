import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { ApiService } from '../../core/api';
import { SessionService } from '../../core/session';
import { Forms } from '../../shared/form-dialog';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';

/** What the server reports about itself; the owner can change a setting from here. */
@Component({
  selector: 'c2a-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    Icon,
  ],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <div class="page">
      <div class="tools">
        <mat-form-field
          class="grow"
          subscriptSizing="dynamic"
          appearance="outline"
        >
          <c2a-icon matPrefix name="search" class="prefix" />
          <input
            matInput
            placeholder="Find a setting"
            [ngModel]="filter()"
            (ngModelChange)="filter.set($event)"
          />
        </mat-form-field>
        @if (session.can('owner')) {
          <button mat-flat-button (click)="edit('', '')">Set…</button>
        }
      </div>
      <p class="muted small">
        What {{ session.server() }} reports publicly. A change can be undone by
        a server restart, unless it's in the server's config too.
      </p>
      <ul>
        @for (cvar of visible(); track cvar.name) {
          <li>
            <div class="grow">
              <div class="mono name">{{ cvar.name }}</div>
              <div class="value">{{ cvar.value || '(empty)' }}</div>
            </div>
            @if (session.can('owner')) {
              <button
                mat-icon-button
                [attr.aria-label]="'Change ' + cvar.name"
                (click)="edit(cvar.name, cvar.value)"
              >
                <c2a-icon name="edit" />
              </button>
            }
          </li>
        } @empty {
          @if (!loading()) {
            <li class="muted">Nothing to show.</li>
          }
        }
      </ul>
    </div>
  `,
  styles: `
    .tools {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .grow {
      flex: 1;
      min-width: 0;
    }
    .prefix {
      margin: 0 4px 0 12px;
    }
    .small {
      font: var(--mat-sys-body-small);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .name {
      font-weight: 600;
    }
    .value {
      overflow-wrap: anywhere;
    }
  `,
})
export class SettingsPage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  private readonly forms = inject(Forms);
  protected readonly session = inject(SessionService);

  protected readonly cvars = signal<{ name: string; value: string }[]>([]);
  protected readonly filter = signal('');
  protected readonly loading = signal(false);
  protected readonly visible = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    return this.cvars().filter(
      (cvar) =>
        !needle ||
        cvar.name.toLowerCase().includes(needle) ||
        cvar.value.toLowerCase().includes(needle),
    );
  });

  constructor() {
    effect(() => {
      const alias = this.session.server();
      untracked(() => void this.load(alias));
    });
  }

  private async load(alias = this.session.server()): Promise<void> {
    this.loading.set(true);
    try {
      const { cvars } = await this.api.cvars(alias);
      if (alias === this.session.server()) {
        this.cvars.set(cvars);
      }
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected async edit(name: string, value: string): Promise<void> {
    const values = await this.forms.open({
      title: name ? `Change ${name}` : 'Set a server setting',
      confirm: 'Set',
      fields: [
        ...(name
          ? []
          : [{ key: 'name', label: 'Setting', required: true, mono: true }]),
        { key: 'value', label: 'Value', value },
      ],
    });
    if (!values) {
      return;
    }
    try {
      const result = await this.api.setCvar(this.session.server(), {
        name: name || String(values['name']),
        value: String(values['value']),
      });
      this.notify.success(result.message);
      await this.load();
    } catch (error) {
      this.notify.error(error);
    }
  }
}
