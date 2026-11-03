import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';

export interface FormField {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'number' | 'textarea' | 'select' | 'checkbox';
  value?: string | boolean;
  hint?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  mono?: boolean;
}

export interface FormData {
  title: string;
  message?: string;
  confirm: string;
  fields: FormField[];
}

export type FormValues = Record<string, string | boolean>;

/** The small forms the management pages need: add an admin, a server, a note… */
@Component({
  selector: 'c2a-form-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      @if (data.message) {
        <p class="muted">{{ data.message }}</p>
      }
      @for (field of data.fields; track field.key) {
        @switch (field.type) {
          @case ('select') {
            <mat-form-field class="full-width">
              <mat-label>{{ field.label }}</mat-label>
              <mat-select
                [value]="values()[field.key]"
                (valueChange)="set(field.key, $event)"
              >
                @for (option of field.options; track option.value) {
                  <mat-option [value]="option.value">{{
                    option.label
                  }}</mat-option>
                }
              </mat-select>
              @if (field.hint) {
                <mat-hint>{{ field.hint }}</mat-hint>
              }
            </mat-form-field>
          }
          @case ('checkbox') {
            <p>
              <mat-checkbox
                [checked]="values()[field.key] === true"
                (change)="set(field.key, $event.checked)"
                >{{ field.label }}</mat-checkbox
              >
            </p>
          }
          @case ('textarea') {
            <mat-form-field class="full-width">
              <mat-label>{{ field.label }}</mat-label>
              <textarea
                matInput
                rows="3"
                [ngModel]="values()[field.key]"
                (ngModelChange)="set(field.key, $event)"
              ></textarea>
              @if (field.hint) {
                <mat-hint>{{ field.hint }}</mat-hint>
              }
            </mat-form-field>
          }
          @default {
            <mat-form-field class="full-width">
              <mat-label>{{ field.label }}</mat-label>
              <input
                matInput
                [class.mono]="field.mono"
                [type]="field.type ?? 'text'"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                [ngModel]="values()[field.key]"
                (ngModelChange)="set(field.key, $event)"
              />
              @if (field.hint) {
                <mat-hint>{{ field.hint }}</mat-hint>
              }
            </mat-form-field>
          }
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button
        mat-flat-button
        [disabled]="!valid()"
        [mat-dialog-close]="values()"
      >
        {{ data.confirm }}
      </button>
    </mat-dialog-actions>
  `,
})
export class FormDialog {
  protected readonly data = inject<FormData>(MAT_DIALOG_DATA);
  protected readonly values = signal<FormValues>(
    Object.fromEntries(
      this.data.fields.map((field) => [
        field.key,
        field.value ?? (field.type === 'checkbox' ? false : ''),
      ]),
    ),
  );
  protected readonly valid = computed(() =>
    this.data.fields.every(
      (field) =>
        !field.required || String(this.values()[field.key] ?? '').trim() !== '',
    ),
  );

  protected set(key: string, value: string | boolean): void {
    this.values.update((values) => ({ ...values, [key]: value }));
  }
}

@Injectable({ providedIn: 'root' })
export class Forms {
  private readonly dialog = inject(MatDialog);

  /** `null` when cancelled. */
  async open(data: FormData): Promise<FormValues | null> {
    const ref = this.dialog.open(FormDialog, {
      data,
      autoFocus: false,
      maxWidth: '460px',
      width: '92vw',
    });
    return ((await firstValueFrom(ref.afterClosed())) as FormValues) ?? null;
  }
}
