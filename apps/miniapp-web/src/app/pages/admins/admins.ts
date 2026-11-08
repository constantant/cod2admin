import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type {
  AdminDto,
  AdminsResponse,
  Permission,
  PermissionTemplate,
} from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { SessionService } from '../../core/session';
import { formatAgo } from '../../shared/format';
import { Icon } from '../../shared/icon';
import { t, T } from '../../shared/i18n';
import { Notify } from '../../shared/notify';

/** English checklist labels. Russian lives in i18n-ru.ts, looked up with `| t`. */
const PERMISSION_LABEL: Record<Permission, string> = {
  kick: 'Kick',
  tempban: 'Temp ban',
  mute: 'Mute',
  ban: 'Ban',
  say: 'Say',
  maps: 'Maps',
  presets: 'Presets',
  vpn: 'VPN',
  'cvars.read': 'View settings',
  'cvars.write': 'Change settings',
  'servers.view': 'View server addresses',
  'servers.assign': 'Assign servers',
  'servers.manage': 'Add and remove servers',
  'notes.manage': "Edit others' notes",
  'admins.manage': 'Manage staff',
  audit: 'Audit log',
  rcon: 'Console',
  update: 'Update the bot',
  relays: 'Telegram routes',
  templates: 'Game chat lines',
  logs: 'Find the game log',
};

/** Who may use the bot: add someone, change what they can do, or remove them. */
@Component({
  selector: 'c2a-admins-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
    NgTemplateOutlet,
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
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
      @if (data(); as data) {
        @if (!adding()) {
          <button mat-flat-button class="add" (click)="beginAdd()">
            <c2a-icon name="add" /> {{ 'Add someone' | t }}
          </button>
        } @else {
          <section class="card add-form">
            <h2>{{ 'Add someone' | t }}</h2>
            <mat-form-field
              class="full-width"
              subscriptSizing="dynamic"
              appearance="outline"
            >
              <mat-label>{{ 'Telegram ID' | t }}</mat-label>
              <input
                matInput
                class="mono"
                inputmode="numeric"
                autocomplete="off"
                [ngModel]="telegramId()"
                (ngModelChange)="telegramId.set($event)"
              />
            </mat-form-field>
            <p class="muted small">
              {{
                'They can find their Telegram ID by opening this app: it shows it when they have no access.'
                  | t
              }}
            </p>
            <ng-container [ngTemplateOutlet]="editor" />
            <div class="actions">
              <button mat-button (click)="cancel()">
                {{ 'Cancel' | t }}
              </button>
              <button
                mat-flat-button
                [disabled]="!idValid()"
                (click)="saveNew()"
              >
                {{ 'Add' | t }}
              </button>
            </div>
          </section>
        }
        <ul>
          @for (admin of data.admins; track admin.telegramId) {
            <li class="card">
              <div class="row">
                <div class="who">
                  <div class="name">
                    {{ name(admin) }}
                    @if (admin.telegramId === myId()) {
                      <span class="muted">{{ '(you)' | t }}</span>
                    }
                  </div>
                  <div class="muted small mono">{{ admin.telegramId }}</div>
                  <div class="muted small">
                    @if (admin.isOwner) {
                      {{ 'owner' | t }}
                    } @else if (admin.permissions.length === 0) {
                      {{ 'none' | t }}
                    } @else {
                      {{ permissionText(admin) }}
                    }
                    @if (admin.addedBy) {
                      {{ '· added by' | t }} {{ admin.addedBy }},
                      {{ ago(admin.addedAt) }}
                    }
                  </div>
                </div>
                @if (admin.manageable) {
                  <button
                    mat-icon-button
                    [attr.aria-label]="'Edit' | t"
                    (click)="beginEdit(admin)"
                  >
                    <c2a-icon name="edit" />
                  </button>
                  <button
                    mat-icon-button
                    [attr.aria-label]="'Remove' | t"
                    (click)="remove(admin)"
                  >
                    <c2a-icon name="delete" />
                  </button>
                }
              </div>
              @if (editingId() === admin.telegramId) {
                <ng-container [ngTemplateOutlet]="editor" />
                <div class="actions">
                  <button mat-button (click)="cancel()">
                    {{ 'Cancel' | t }}
                  </button>
                  <button mat-flat-button (click)="saveEdit(admin)">
                    {{ 'Save' | t }}
                  </button>
                </div>
              }
            </li>
          }
        </ul>
      }
    </div>

    <ng-template #editor>
      @if (data(); as data) {
        <div class="templates">
          @for (template of data.templates; track template.id) {
            <button
              type="button"
              mat-stroked-button
              (click)="applyTemplate(template)"
            >
              {{ templateLabel(template.id) | t }}
            </button>
          }
        </div>
        <div class="checks">
          @for (id of data.catalog; track id) {
            <mat-checkbox
              [checked]="checked().has(id)"
              [disabled]="locked(id)"
              (change)="toggle(id, $event.checked)"
              >{{ label(id) | t }}</mat-checkbox
            >
          }
        </div>
        @if (session.me()?.isOwner !== true) {
          <p class="muted small">
            {{ 'Only the owner can grant the console and bot update.' | t }}
          </p>
        }
      }
    </ng-template>
  `,
  styles: `
    .add {
      margin-bottom: 12px;
    }
    .add-form {
      margin-bottom: 12px;
    }
    h2 {
      font: var(--mat-sys-title-small);
      margin: 0 0 8px;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
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
    .templates {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .checks {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 2px 12px;
      margin: 8px 0;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  `,
})
export class AdminsPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  protected readonly session = inject(SessionService);

  protected readonly data = signal<AdminsResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly adding = signal(false);
  protected readonly editingId = signal<number | null>(null);
  protected readonly telegramId = signal('');
  protected readonly checked = signal<ReadonlySet<Permission>>(new Set());

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

  protected label(id: Permission): string {
    return PERMISSION_LABEL[id] ?? id;
  }

  protected templateLabel(id: 'moderator' | 'admin'): string {
    return id === 'admin' ? 'Admin' : 'Moderator';
  }

  protected permissionText(admin: AdminDto): string {
    return admin.permissions.map((id) => t(this.label(id))).join(', ');
  }

  protected ago(iso: string): string {
    return formatAgo(iso);
  }

  /** `rcon` and `update`: a non-owner sees them, but cannot tick a new one. */
  protected locked(id: Permission): boolean {
    const granted = this.data()?.ownerGranted;
    return (
      this.session.me()?.isOwner !== true && (granted?.includes(id) ?? false)
    );
  }

  protected idValid(): boolean {
    const id = Number(this.telegramId().trim());
    return Number.isSafeInteger(id) && id > 0;
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

  protected beginAdd(): void {
    this.editingId.set(null);
    this.telegramId.set('');
    this.checked.set(new Set());
    this.adding.set(true);
  }

  protected beginEdit(admin: AdminDto): void {
    this.adding.set(false);
    if (this.editingId() !== admin.telegramId) {
      this.editingId.set(admin.telegramId);
      this.checked.set(new Set(admin.permissions));
    }
  }

  protected cancel(): void {
    this.adding.set(false);
    this.editingId.set(null);
  }

  /**
   * Ticks exactly the template. A non-owner keeps an owner-only grant that is
   * already on, and never turns one on that is off.
   */
  protected applyTemplate(template: PermissionTemplate): void {
    const data = this.data();
    if (!data) {
      return;
    }
    const owner = this.session.me()?.isOwner === true;
    const next = new Set<Permission>();
    for (const id of template.permissions) {
      if (!owner && data.ownerGranted.includes(id)) {
        continue;
      }
      next.add(id);
    }
    if (!owner) {
      for (const id of data.ownerGranted) {
        if (this.checked().has(id)) {
          next.add(id);
        }
      }
    }
    this.checked.set(next);
  }

  protected toggle(id: Permission, on: boolean): void {
    if (this.locked(id)) {
      return;
    }
    const next = new Set(this.checked());
    if (on) {
      next.add(id);
    } else {
      next.delete(id);
    }
    this.checked.set(next);
  }

  /** Catalog order, including a disabled owner grant that is already checked. */
  private selectedPermissions(): Permission[] {
    const checked = this.checked();
    return (this.data()?.catalog ?? []).filter((id) => checked.has(id));
  }

  protected async saveNew(): Promise<void> {
    if (!this.idValid()) {
      return;
    }
    const ok = await this.run(() =>
      this.api.addAdmin({
        telegramId: Number(this.telegramId().trim()),
        permissions: this.selectedPermissions(),
      }),
    );
    if (ok) {
      this.adding.set(false);
    }
  }

  protected async saveEdit(admin: AdminDto): Promise<void> {
    const ok = await this.run(() =>
      this.api.setAdminPermissions(
        admin.telegramId,
        this.selectedPermissions(),
      ),
    );
    if (ok) {
      this.editingId.set(null);
    }
  }

  protected async remove(admin: AdminDto): Promise<void> {
    const ok = await this.notify.confirm({
      title: `Remove ${this.name(admin)}?`,
      message: "They'll lose access to the bot and this app right away.",
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) {
      return;
    }
    if (this.editingId() === admin.telegramId) {
      this.editingId.set(null);
    }
    await this.run(() => this.api.removeAdmin(admin.telegramId));
  }

  private async run(
    action: () => Promise<{ message: string }>,
  ): Promise<boolean> {
    try {
      this.notify.success((await action()).message);
      return true;
    } catch (error) {
      this.notify.error(error);
      return false;
    } finally {
      await this.load();
    }
  }
}
