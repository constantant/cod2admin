import { ChangeDetectionStrategy, Component, inject, Injectable } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import { toApiFailure } from '../core/api';
import { TelegramService } from '../core/telegram';

export interface ConfirmData {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
}

@Component({
  selector: 'c2a-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>{{ data.message }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="false">Cancel</button>
      <button mat-flat-button [class.danger]="data.danger" [mat-dialog-close]="true">{{ data.confirm }}</button>
    </mat-dialog-actions>
  `,
  styles: `
    .danger {
      --mat-button-filled-container-color: var(--mat-sys-error);
      --mat-button-filled-label-text-color: var(--mat-sys-on-error);
    }
  `,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
}

/** Feedback for actions: a snackbar plus a haptic buzz inside Telegram, and confirmations. */
@Injectable({ providedIn: 'root' })
export class Notify {
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly telegram = inject(TelegramService);

  success(message: string): void {
    this.telegram.haptic('success');
    this.snackBar.open(message, undefined, { duration: 3000 });
  }

  info(message: string): void {
    this.snackBar.open(message, 'OK', { duration: 8000 });
  }

  error(error: unknown): void {
    this.telegram.haptic('error');
    this.snackBar.open(toApiFailure(error).message, 'OK', { duration: 6000 });
  }

  async confirm(data: ConfirmData): Promise<boolean> {
    this.telegram.haptic('warning');
    const ref = this.dialog.open(ConfirmDialog, { data, autoFocus: false, maxWidth: '420px' });
    return (await firstValueFrom(ref.afterClosed())) === true;
  }
}
