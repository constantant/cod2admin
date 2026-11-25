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
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import type {
  BackupFileDto,
  BackupGroup,
  BackupPreviewResponse,
  BackupSchedule,
  BackupSource,
  BackupStatusResponse,
} from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { T } from '../../shared/i18n';
import { Notify } from '../../shared/notify';

const MB = 1024 * 1024;
const sizeText = (bytes: number): string =>
  bytes >= MB
    ? `${(bytes / MB).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Backups (docs/PLAN-backup.md): make an encrypted file of the bot's data, restore from one, and
 * set a schedule that sends it to the owner's Telegram chat. Needs `backup.manage`.
 */
@Component({
  selector: 'c2a-backup-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
  ],
  template: `
    <div class="page">
      @if (data(); as data) {
        <section class="card">
          <h2>{{ 'Make a backup' | t }}</h2>
          <p class="muted small">
            {{
              'The file is encrypted with a passphrase you choose. Keep the passphrase: without it the file cannot be opened.'
                | t
            }}
          </p>
          <div class="groups">
            @for (group of data.groups; track group.id) {
              <mat-checkbox
                [checked]="isChosen(group.id)"
                [disabled]="group.id === 'core'"
                (change)="toggleGroup(group.id, $event.checked)"
                >{{ groupLabel(group.id) | t }}</mat-checkbox
              >
            }
          </div>
          <mat-form-field subscriptSizing="dynamic" appearance="outline">
            <mat-label>{{ 'Passphrase' | t }}</mat-label>
            <input
              matInput
              type="password"
              name="makePassphrase"
              autocomplete="new-password"
              [ngModel]="makePassphrase()"
              (ngModelChange)="makePassphrase.set($event)"
            />
          </mat-form-field>
          <div class="row">
            <button
              mat-flat-button
              [disabled]="busy() || makePassphrase().length < 12"
              (click)="create()"
            >
              {{ 'Make a backup' | t }}
            </button>
          </div>
          <p class="muted small">
            {{ 'At least 12 characters.' | t }}
          </p>
        </section>

        <section class="card">
          <h2>{{ 'Backups on the bot' | t }}</h2>
          @if (!data.files.length) {
            <p class="muted">{{ 'No backups yet.' | t }}</p>
          }
          @for (file of data.files; track file.name) {
            <div class="file">
              <div class="grow">
                <div class="mono">{{ file.name }}</div>
                <div class="muted small">
                  {{ size(file) }} ·
                  {{ file.modifiedAt.slice(0, 16).replace('T', ' ') }}
                </div>
              </div>
              <div class="actions">
                <button mat-button (click)="download(file)">
                  {{ 'Download' | t }}
                </button>
                <button mat-button (click)="send(file)">
                  {{ 'Send to my chat' | t }}
                </button>
                <button mat-button (click)="pick({ file: file.name })">
                  {{ 'Restore' | t }}
                </button>
                <button mat-button (click)="remove(file)">
                  {{ 'Delete' | t }}
                </button>
              </div>
            </div>
          }
          <p class="muted small mono">{{ data.dir }}</p>
        </section>

        <section class="card">
          <h2>{{ 'Restore from a file' | t }}</h2>
          <p class="muted small">
            {{
              'Choose a backup from this device, or use Restore on a file above.'
                | t
            }}
          </p>
          <input
            #fileInput
            type="file"
            hidden
            accept=".c2bak,.001,application/octet-stream"
            (change)="upload(fileInput)"
          />
          <button
            mat-stroked-button
            [disabled]="busy()"
            (click)="fileInput.click()"
          >
            {{ 'Choose a file' | t }}
          </button>

          @if (source(); as source) {
            <div class="restore">
              <div class="muted small mono">{{ sourceLabel(source) }}</div>
              <mat-form-field subscriptSizing="dynamic" appearance="outline">
                <mat-label>{{ 'Passphrase of this backup' | t }}</mat-label>
                <input
                  matInput
                  type="password"
                  name="restorePassphrase"
                  autocomplete="off"
                  [ngModel]="restorePassphrase()"
                  (ngModelChange)="
                    restorePassphrase.set($event); preview.set(null)
                  "
                />
              </mat-form-field>
              <div class="row">
                <button
                  mat-stroked-button
                  [disabled]="busy() || !restorePassphrase()"
                  (click)="check()"
                >
                  {{ 'Check the file' | t }}
                </button>
                <button mat-button (click)="cancelRestore()">
                  {{ 'Cancel' | t }}
                </button>
              </div>

              @if (preview(); as preview) {
                <p class="muted small">
                  {{ 'Made' | t }}
                  {{ preview.created.slice(0, 16).replace('T', ' ') }} ·
                  {{ 'bot version' | t }} {{ preview.app }}
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>{{ 'Table' | t }}</th>
                      <th>{{ 'In file' | t }}</th>
                      <th>{{ 'Now' | t }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (table of preview.tables; track table.name) {
                      <tr>
                        <td class="mono">{{ table.name }}</td>
                        <td>{{ table.fileRows }}</td>
                        <td>{{ table.currentRows }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
                @for (warning of preview.warnings; track warning) {
                  <p class="warn small">{{ warning }}</p>
                }
                <p class="warn">
                  {{
                    'This replaces the data above with the file. The current data is saved to a file on the bot first, and the bot restarts.'
                      | t
                  }}
                </p>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Type REPLACE to confirm' | t }}</mat-label>
                  <input
                    matInput
                    name="confirm"
                    autocapitalize="characters"
                    autocomplete="off"
                    [ngModel]="confirmText()"
                    (ngModelChange)="confirmText.set($event)"
                  />
                </mat-form-field>
                <div class="row">
                  <button
                    mat-flat-button
                    class="danger"
                    [disabled]="busy() || confirmText() !== 'REPLACE'"
                    (click)="restore()"
                  >
                    {{ 'Restore' | t }}
                  </button>
                </div>
              }
            </div>
          }
        </section>

        <section class="card">
          <h2>{{ 'Schedule' | t }}</h2>
          <p class="muted small">
            {{
              'The bot makes a backup on a schedule, keeps a few on its disk, and sends the encrypted file to the owner’s chat with the bot.'
                | t
            }}
          </p>

          <div class="block">
            <div>
              {{ 'Passphrase for scheduled backups' | t }}:
              <strong>{{
                (data.passphraseSet ? 'saved' : 'not set') | t
              }}</strong>
            </div>
            @if (data.passphraseFromConfig) {
              <p class="muted small">
                {{
                  'It comes from the bot’s config file (BACKUP_PASSPHRASE).' | t
                }}
              </p>
            } @else {
              <mat-form-field subscriptSizing="dynamic" appearance="outline">
                <mat-label>{{ 'New passphrase' | t }}</mat-label>
                <input
                  matInput
                  type="password"
                  name="schedulePassphrase"
                  autocomplete="new-password"
                  [ngModel]="schedulePassphrase()"
                  (ngModelChange)="schedulePassphrase.set($event)"
                />
              </mat-form-field>
              <div class="row">
                <button
                  mat-stroked-button
                  [disabled]="busy() || schedulePassphrase().length < 12"
                  (click)="savePassphrase()"
                >
                  {{ 'Save passphrase' | t }}
                </button>
                @if (data.passphraseSet) {
                  <button
                    mat-button
                    [disabled]="busy()"
                    (click)="forgetPassphrase()"
                  >
                    {{ 'Forget it' | t }}
                  </button>
                }
              </div>
              <p class="muted small">
                {{
                  'It is stored on the bot, encrypted. If you forget it, those backups cannot be opened.'
                    | t
                }}
              </p>
            }
          </div>

          <mat-slide-toggle
            [checked]="schedule().enabled"
            [disabled]="busy()"
            (change)="setSchedule({ enabled: $event.checked })"
            >{{ 'Back up on a schedule' | t }}</mat-slide-toggle
          >

          <div class="form">
            <mat-form-field subscriptSizing="dynamic" appearance="outline">
              <mat-label>{{ 'How often' | t }}</mat-label>
              <mat-select
                [value]="schedule().mode"
                (selectionChange)="setSchedule({ mode: $event.value })"
              >
                <mat-option value="daily">{{
                  'Every day at a time' | t
                }}</mat-option>
                <mat-option value="hours">{{
                  'Every few hours' | t
                }}</mat-option>
              </mat-select>
            </mat-form-field>
            @if (schedule().mode === 'daily') {
              <mat-form-field subscriptSizing="dynamic" appearance="outline">
                <mat-label>{{ 'Time (bot’s local time)' | t }}</mat-label>
                <input
                  matInput
                  type="time"
                  name="at"
                  [ngModel]="schedule().at"
                  (change)="setSchedule({ at: timeValue($event) })"
                />
              </mat-form-field>
            } @else {
              <mat-form-field subscriptSizing="dynamic" appearance="outline">
                <mat-label>{{ 'Every how many hours' | t }}</mat-label>
                <input
                  matInput
                  type="number"
                  min="1"
                  max="720"
                  name="hours"
                  [ngModel]="schedule().hours"
                  (change)="setSchedule({ hours: numberValue($event) })"
                />
              </mat-form-field>
            }
            <mat-form-field subscriptSizing="dynamic" appearance="outline">
              <mat-label>{{ 'Send to Telegram' | t }}</mat-label>
              <mat-select
                [value]="schedule().telegram"
                (selectionChange)="setSchedule({ telegram: $event.value })"
              >
                <mat-option value="file">{{ 'The file' | t }}</mat-option>
                <mat-option value="notify">{{
                  'Only a message' | t
                }}</mat-option>
                <mat-option value="off">{{ 'Nothing' | t }}</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field subscriptSizing="dynamic" appearance="outline">
              <mat-label>{{ 'Keep on the bot' | t }}</mat-label>
              <input
                matInput
                type="number"
                min="1"
                max="60"
                name="keep"
                [ngModel]="schedule().keepLocal"
                (change)="setSchedule({ keepLocal: numberValue($event) })"
              />
            </mat-form-field>
          </div>
          <div class="groups">
            @for (group of data.groups; track group.id) {
              <mat-checkbox
                [checked]="schedule().groups.includes(group.id)"
                [disabled]="group.id === 'core'"
                (change)="setScheduleGroup(group.id, $event.checked)"
                >{{ groupLabel(group.id) | t }}</mat-checkbox
              >
            }
          </div>
          @if (!data.ownerChat && schedule().telegram !== 'off') {
            <p class="warn small">
              {{
                'No owner has claimed the bot, so nothing can be sent to Telegram.'
                  | t
              }}
            </p>
          }
          <p class="muted small">
            {{
              'A file over 50 MB is sent without the history and watch data, or in parts. The full file stays on the bot.'
                | t
            }}
          </p>
          <div class="row">
            <button mat-stroked-button [disabled]="busy()" (click)="runNow()">
              {{ 'Back up now' | t }}
            </button>
          </div>
          @if (data.lastRun; as last) {
            <p class="small" [class.warn]="!last.ok">
              {{ 'Last run' | t }}:
              {{ last.at.slice(0, 16).replace('T', ' ') }} —
              {{ last.message }}
            </p>
          }
        </section>
      }
    </div>
  `,
  styles: `
    h2 {
      font: var(--mat-sys-title-small);
      margin: 0 0 8px;
    }
    .small {
      font: var(--mat-sys-body-small);
    }
    .warn {
      color: var(--mat-sys-error);
    }
    .groups {
      display: flex;
      flex-wrap: wrap;
      gap: 0 12px;
      margin-bottom: 8px;
    }
    .row {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .file {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
    }
    .grow {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .form {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 8px;
      margin: 12px 0;
    }
    .block {
      margin-bottom: 12px;
    }
    mat-form-field {
      width: 100%;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font: var(--mat-sys-body-small);
    }
    th,
    td {
      text-align: left;
      padding: 2px 8px 2px 0;
    }
    .danger {
      --mat-button-filled-container-color: var(--mat-sys-error);
      --mat-button-filled-label-text-color: var(--mat-sys-on-error);
    }
  `,
})
export class BackupPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);

  protected readonly data = signal<BackupStatusResponse | null>(null);
  protected readonly busy = signal(false);
  protected readonly schedule = signal<BackupSchedule>({
    enabled: false,
    mode: 'daily',
    at: '04:00',
    hours: 24,
    groups: ['core'],
    telegram: 'file',
    keepLocal: 7,
  });

  protected readonly chosen = signal<BackupGroup[]>([
    'core',
    'bans',
    'history',
    'functions',
  ]);
  protected readonly makePassphrase = signal('');
  protected readonly schedulePassphrase = signal('');

  protected readonly source = signal<BackupSource | null>(null);
  protected readonly restorePassphrase = signal('');
  protected readonly confirmText = signal('');
  protected readonly preview = signal<BackupPreviewResponse | null>(null);

  ngOnInit(): void {
    void this.reload();
  }

  protected size(file: BackupFileDto): string {
    return sizeText(file.bytes);
  }

  protected groupLabel(id: BackupGroup): string {
    return {
      core: 'Admins, servers and settings',
      bans: 'Bans and mutes',
      history: 'Audit log, reports, notes and players',
      functions: 'Custom functions',
      watch: 'Watcher data (large)',
    }[id];
  }

  protected isChosen(id: BackupGroup): boolean {
    return this.chosen().includes(id);
  }

  protected toggleGroup(id: BackupGroup, on: boolean): void {
    this.chosen.update((groups) =>
      on ? [...new Set([...groups, id])] : groups.filter((g) => g !== id),
    );
  }

  protected sourceLabel(source: BackupSource): string {
    return 'file' in source ? source.file : 'uploaded file';
  }

  protected timeValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected numberValue(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }

  private async reload(): Promise<void> {
    try {
      const data = await this.api.backup();
      this.data.set(data);
      this.schedule.set(data.schedule);
    } catch (error) {
      this.notify.error(error);
    }
  }

  /** Runs one action with the buttons locked, then shows what the bot says now. */
  private async act(
    work: () => Promise<{ message?: string } | void>,
    reload = true,
  ): Promise<boolean> {
    this.busy.set(true);
    try {
      const result = await work();
      if (result && result.message) {
        this.notify.success(result.message);
      }
      if (reload) {
        await this.reload();
      }
      return true;
    } catch (error) {
      this.notify.error(error);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  protected async create(): Promise<void> {
    const passphrase = this.makePassphrase();
    const ok = await this.act(async () => {
      const file = await this.api.createBackup({
        passphrase,
        groups: this.chosen(),
      });
      void file;
      return { message: 'Backup saved.' };
    });
    if (ok) {
      this.makePassphrase.set('');
    }
  }

  protected async download(file: BackupFileDto): Promise<void> {
    await this.act(async () => {
      const blob = await this.api.downloadBackup(file.name);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }, false);
  }

  protected send(file: BackupFileDto): Promise<boolean> {
    return this.act(() => this.api.sendBackup(file.name), false);
  }

  protected async remove(file: BackupFileDto): Promise<void> {
    const ok = await this.notify.confirm({
      title: 'Delete this backup?',
      message: file.name,
      confirm: 'Delete',
      danger: true,
    });
    if (ok) {
      await this.act(() => this.api.deleteBackup(file.name));
    }
  }

  protected pick(source: BackupSource): void {
    this.source.set(source);
    this.restorePassphrase.set('');
    this.confirmText.set('');
    this.preview.set(null);
  }

  protected cancelRestore(): void {
    this.source.set(null);
    this.restorePassphrase.set('');
    this.confirmText.set('');
    this.preview.set(null);
  }

  protected async upload(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    await this.act(async () => {
      const done = await this.api.uploadBackup(file);
      this.pick({ upload: done.upload });
    }, false);
  }

  protected async check(): Promise<void> {
    const source = this.source();
    if (!source) {
      return;
    }
    await this.act(async () => {
      this.preview.set(
        await this.api.previewBackup({
          source,
          passphrase: this.restorePassphrase(),
        }),
      );
    }, false);
  }

  protected async restore(): Promise<void> {
    const source = this.source();
    if (!source) {
      return;
    }
    const ok = await this.notify.confirm({
      title: 'Replace the data with this backup?',
      message:
        'Everything the bot has now is replaced. It is saved to a file first.',
      confirm: 'Restore',
      danger: true,
    });
    if (!ok) {
      return;
    }
    await this.act(async () => {
      const done = await this.api.restoreBackup({
        source,
        passphrase: this.restorePassphrase(),
        confirm: this.confirmText(),
      });
      this.cancelRestore();
      return done;
    }, false);
  }

  protected async setSchedule(change: Partial<BackupSchedule>): Promise<void> {
    const before = this.schedule();
    const next = { ...before, ...change };
    this.schedule.set(next);
    const ok = await this.act(() => this.api.setBackupSchedule(next));
    if (!ok) {
      this.schedule.set(before);
    }
  }

  protected setScheduleGroup(id: BackupGroup, on: boolean): Promise<void> {
    const groups = this.schedule().groups;
    return this.setSchedule({
      groups: on
        ? [...new Set([...groups, id])]
        : groups.filter((g) => g !== id),
    });
  }

  protected async savePassphrase(): Promise<void> {
    const ok = await this.act(() =>
      this.api.setBackupPassphrase(this.schedulePassphrase()),
    );
    if (ok) {
      this.schedulePassphrase.set('');
    }
  }

  protected async forgetPassphrase(): Promise<void> {
    const ok = await this.notify.confirm({
      title: 'Forget the saved passphrase?',
      message: 'The schedule turns off until you save one again.',
      confirm: 'Forget',
      danger: true,
    });
    if (ok) {
      await this.act(() => this.api.setBackupPassphrase(null));
    }
  }

  protected runNow(): Promise<boolean> {
    return this.act(() => this.api.runBackup());
  }
}
