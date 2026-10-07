import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatChipsModule } from '@angular/material/chips';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { AddBanRequest, BanDto, UpdateBanRequest } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { DURATION_CHOICES, formatSpan } from '../../shared/format';
import { Notify } from '../../shared/notify';

/** `keep` leaves the expiry alone, `permanent` clears it, a number sets it that many minutes from now. */
type ExpiryChoice = 'keep' | 'permanent' | number;

/** Edit a ban's reason and expiry (docs/PLAN-miniapp.md §6.3). Closes with the updated ban. */
@Component({
  selector: 'c2a-edit-ban-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatChipsModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Edit ban</h2>
    <mat-dialog-content>
      <p class="muted">
        {{ ban.kind === 'ip' ? 'IP ' + ban.ip : ban.name + ' (GUID ' + ban.guid + ')' }} ·
        {{ ban.expiresAt ? 'expires in ' + remaining : 'permanent' }}
      </p>
      <mat-form-field class="full-width">
        <mat-label>Reason</mat-label>
        <input matInput [(ngModel)]="reason" maxlength="200" />
      </mat-form-field>
      <div class="label">Expiry</div>
      <mat-chip-listbox aria-label="Expiry" [value]="expiry()" (change)="expiry.set($event.value ?? 'keep')">
        <mat-chip-option value="keep">Keep</mat-chip-option>
        <mat-chip-option value="permanent">Permanent</mat-chip-option>
        @for (choice of durations; track choice.minutes) {
          <mat-chip-option [value]="choice.minutes">{{ choice.label }} from now</mat-chip-option>
        }
      </mat-chip-listbox>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="busy()" (click)="save()">Save</button>
    </mat-dialog-actions>
  `,
  styles: `
    .label {
      font: var(--mat-sys-label-large);
      margin: 4px 0 8px;
    }
  `,
})
export class EditBanDialog {
  protected readonly ban = inject<BanDto>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<EditBanDialog, BanDto>);
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);

  protected readonly durations = DURATION_CHOICES;
  protected readonly reason = signal(this.ban.reason ?? '');
  protected readonly expiry = signal<ExpiryChoice>('keep');
  protected readonly busy = signal(false);
  protected readonly remaining = this.ban.expiresAt ? formatSpan(new Date(this.ban.expiresAt).getTime() - Date.now()) : '';

  protected async save(): Promise<void> {
    const body: UpdateBanRequest = {};
    if (this.reason().trim() !== (this.ban.reason ?? '')) {
      body.reason = this.reason().trim() || null;
    }
    const expiry = this.expiry();
    if (expiry === 'permanent') {
      body.expiresAt = null;
    } else if (typeof expiry === 'number') {
      body.expiresAt = new Date(Date.now() + expiry * 60_000).toISOString();
    }
    if (Object.keys(body).length === 0) {
      this.ref.close();
      return;
    }
    this.busy.set(true);
    try {
      const result = await this.api.updateBan(this.ban.kind, this.ban.id, body);
      if (result.warning) {
        this.notify.info(result.warning);
      } else {
        this.notify.success('Ban updated.');
      }
      this.ref.close(result.ban);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}

/**
 * Ban someone who isn't online (§6.3): by IP, or by GUID with the name to remember them by.
 * Closes with `true` once the ban is recorded.
 */
@Component({
  selector: 'c2a-add-ban-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatButtonToggleModule, MatChipsModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Add a ban</h2>
    <mat-dialog-content>
      <mat-button-toggle-group class="full-width kind" hideSingleSelectionIndicator [value]="kind()" (change)="kind.set($event.value)">
        <mat-button-toggle value="ip">By IP</mat-button-toggle>
        <mat-button-toggle value="guid">By GUID</mat-button-toggle>
      </mat-button-toggle-group>
      @if (kind() === 'ip') {
        <mat-form-field class="full-width">
          <mat-label>IP address</mat-label>
          <input matInput [(ngModel)]="ip" placeholder="203.0.113.7" inputmode="decimal" autocomplete="off" />
        </mat-form-field>
      } @else {
        <mat-form-field class="full-width">
          <mat-label>GUID</mat-label>
          <input matInput [(ngModel)]="guid" autocomplete="off" />
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>Player name</mat-label>
          <input matInput [(ngModel)]="name" maxlength="64" />
        </mat-form-field>
      }
      <mat-form-field class="full-width">
        <mat-label>Reason (optional)</mat-label>
        <input matInput [(ngModel)]="reason" maxlength="200" />
      </mat-form-field>
      <mat-chip-listbox aria-label="Length" [value]="minutes()" (change)="minutes.set($event.value ?? null)">
        <mat-chip-option [value]="null">Permanent</mat-chip-option>
        @for (choice of durations; track choice.minutes) {
          <mat-chip-option [value]="choice.minutes">{{ choice.label }}</mat-chip-option>
        }
      </mat-chip-listbox>
      <p class="muted small">Applies on every server. Someone online now is kicked within seconds.</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="busy() || !valid()" (click)="save()">Ban</button>
    </mat-dialog-actions>
  `,
  styles: `
    .kind {
      margin-bottom: 16px;
      mat-button-toggle {
        flex: 1;
      }
    }
    .small {
      font: var(--mat-sys-body-small);
    }
  `,
})
export class AddBanDialog {
  private readonly server = inject<string>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<AddBanDialog, boolean>);
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);

  protected readonly durations = DURATION_CHOICES;
  protected readonly kind = signal<'ip' | 'guid'>('ip');
  protected readonly ip = signal('');
  protected readonly guid = signal('');
  protected readonly name = signal('');
  protected readonly reason = signal('');
  protected readonly minutes = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly valid = computed(() =>
    this.kind() === 'ip'
      ? /^\d{1,3}(\.\d{1,3}){3}$/.test(this.ip().trim())
      : /^[0-9A-Za-z]{1,32}$/.test(this.guid().trim()) && this.guid().trim() !== '0' && this.name().trim().length > 0,
  );

  protected async save(): Promise<void> {
    const common = { server: this.server, reason: this.reason().trim() || undefined, durationMinutes: this.minutes() };
    const body: AddBanRequest =
      this.kind() === 'ip'
        ? { ...common, kind: 'ip', ip: this.ip().trim() }
        : { ...common, kind: 'guid', guid: this.guid().trim(), name: this.name().trim() };
    this.busy.set(true);
    try {
      this.notify.success((await this.api.addBan(body)).message);
      this.ref.close(true);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
