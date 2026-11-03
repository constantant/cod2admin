import {
  ChangeDetectionStrategy,
  Component,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import type {
  AdminDto,
  AdminsResponse,
  MiniAppRole,
} from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { SessionService } from '../../core/session';
import { formatAgo } from '../../shared/format';
import { Forms } from '../../shared/form-dialog';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';
import { T } from '../../shared/i18n';

const ROLE_HELP: Record<MiniAppRole, string> = {
  owner: 'Everything',
  admin: 'Bans, maps, chat, moderators',
  moderator: 'Kicks and temp bans',
};

/** Who may use the bot (docs/PLAN-miniapp.md §6.4): `/addadmin`, `/setrole`, `/removeadmin`. */
@Component({
  selector: 'c2a-admins-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [T, MatButtonModule, MatProgressBarModule, MatSelectModule, Icon],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <div class="page">
      <button mat-flat-button class="add" (click)="add()">
        <c2a-icon name="add" /> {{ 'Add someone' | t }}
      </button>
      @if (data(); as data) {
        <ul>
          @for (admin of data.admins; track admin.telegramId) {
            <li class="card">
              <div class="who">
                <div class="name">
                  {{ name(admin) }}
                  @if (admin.telegramId === myId()) {
                    <span class="muted">{{ '(you)' | t }}</span>
                  }
                </div>
                <div class="muted small mono">{{ admin.telegramId }}</div>
                <div class="muted small">
                  {{ help(admin.role) | t }}
                  @if (admin.addedBy) {
                    {{ '· added by' | t }} {{ admin.addedBy }},
                    {{ ago(admin.addedAt) }}
                  }
                </div>
              </div>
              @if (admin.manageable) {
                <mat-select
                  class="role"
                  [aria-label]="'Role' | t"
                  panelWidth="auto"
                  [value]="admin.role"
                  (valueChange)="setRole(admin, $event)"
                >
                  @for (role of rolesFor(data, admin); track role) {
                    <mat-option [value]="role">{{ role | t }}</mat-option>
                  }
                </mat-select>
                <button
                  mat-icon-button
                  [attr.aria-label]="'Remove' | t"
                  (click)="remove(admin)"
                >
                  <c2a-icon name="delete" />
                </button>
              } @else {
                <span class="role fixed">{{ admin.role | t }}</span>
              }
            </li>
          }
        </ul>
        @if (!session.can('owner')) {
          <p class="muted small">
            {{
              'Admins manage moderators; only the owner can change admins.' | t
            }}
          </p>
        }
      }
    </div>
  `,
  styles: `
    .add {
      margin-bottom: 12px;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .who {
      flex: 1;
      min-width: 0;
    }
    .name {
      font: var(--mat-sys-title-small);
      overflow-wrap: anywhere;
    }
    .small {
      font: var(--mat-sys-body-small);
    }
    .role {
      width: 110px;
      flex: none;
      text-transform: capitalize;
    }
    .fixed {
      width: auto;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class AdminsPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  private readonly forms = inject(Forms);
  protected readonly session = inject(SessionService);

  protected readonly data = signal<AdminsResponse | null>(null);
  protected readonly loading = signal(false);

  ngOnInit(): void {
    void this.load();
  }

  protected myId(): number | undefined {
    return this.session.me()?.user.id;
  }

  protected name(admin: AdminDto): string {
    return admin.username
      ? `@${admin.username}`
      : (admin.firstName ?? "Hasn't opened the bot yet");
  }

  protected help(role: MiniAppRole): string {
    return ROLE_HELP[role];
  }

  protected ago(iso: string): string {
    return formatAgo(iso);
  }

  /** Includes their current role, so the picker can show it. */
  protected rolesFor(data: AdminsResponse, admin: AdminDto): MiniAppRole[] {
    return [...new Set([...data.assignable, admin.role])];
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.data.set(await this.api.admins());
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected async add(): Promise<void> {
    const assignable = this.data()?.assignable ?? ['moderator'];
    const values = await this.forms.open({
      title: 'Add someone',
      message:
        'They can find their Telegram ID by opening this app: it shows it when they have no access.',
      confirm: 'Add',
      fields: [
        {
          key: 'telegramId',
          label: 'Telegram ID',
          type: 'number',
          required: true,
          mono: true,
        },
        {
          key: 'role',
          label: 'Role',
          type: 'select',
          value: 'moderator',
          options: assignable.map((role) => ({ value: role, label: role })),
        },
      ],
    });
    if (!values) {
      return;
    }
    await this.run(() =>
      this.api.addAdmin({
        telegramId: Number(values['telegramId']),
        role: values['role'] as MiniAppRole,
      }),
    );
  }

  protected async setRole(admin: AdminDto, role: MiniAppRole): Promise<void> {
    if (role !== admin.role) {
      await this.run(() => this.api.setAdminRole(admin.telegramId, role));
    }
  }

  protected async remove(admin: AdminDto): Promise<void> {
    const ok = await this.notify.confirm({
      title: `Remove ${this.name(admin)}?`,
      message: "They'll lose access to the bot and this app right away.",
      confirm: 'Remove',
      danger: true,
    });
    if (ok) {
      await this.run(() => this.api.removeAdmin(admin.telegramId));
    }
  }

  private async run(action: () => Promise<{ message: string }>): Promise<void> {
    try {
      this.notify.success((await action()).message);
    } catch (error) {
      this.notify.error(error);
    }
    await this.load();
  }
}
