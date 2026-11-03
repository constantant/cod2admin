import {
  ChangeDetectionStrategy,
  Component,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { PresetsService } from '../../core/presets';
import { Notify } from '../../shared/notify';
import { T } from '../../shared/i18n';

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** One-tap reasons, temp-ban lengths and chat lines (docs/PLAN-miniapp.md §6.4), shared by all admins. */
@Component({
  selector: 'c2a-presets-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <div class="page">
      <p class="muted">
        {{ 'One per line. Everyone with access sees the same ones.' | t }}
      </p>
      <mat-form-field class="full-width">
        <mat-label>{{ 'Reasons for kicks and bans' | t }}</mat-label>
        <textarea matInput rows="5" [(ngModel)]="reasons"></textarea>
      </mat-form-field>
      <mat-form-field class="full-width">
        <mat-label>{{ 'Temp-ban lengths, in minutes' | t }}</mat-label>
        <textarea
          matInput
          rows="5"
          class="mono"
          [(ngModel)]="durations"
        ></textarea>
        <mat-hint>{{
          '30 = 30 minutes, 1440 = a day, 10080 = a week' | t
        }}</mat-hint>
      </mat-form-field>
      <mat-form-field class="full-width messages">
        <mat-label>{{ 'Ready-made chat messages' | t }}</mat-label>
        <textarea matInput rows="5" [(ngModel)]="messages"></textarea>
      </mat-form-field>
      <button mat-flat-button [disabled]="busy()" (click)="save()">
        {{ 'Save' | t }}
      </button>
    </div>
  `,
  styles: `
    .messages {
      margin-top: 16px;
    }
  `,
})
export class PresetsPage implements OnInit {
  private readonly service = inject(PresetsService);
  private readonly notify = inject(Notify);

  protected readonly reasons = signal('');
  protected readonly durations = signal('');
  protected readonly messages = signal('');
  protected readonly busy = signal(false);

  async ngOnInit(): Promise<void> {
    await this.service.load();
    const { reasons, durations, messages } = this.service.presets();
    this.reasons.set(reasons.join('\n'));
    this.durations.set(durations.join('\n'));
    this.messages.set(messages.join('\n'));
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    try {
      await this.service.save({
        reasons: lines(this.reasons()),
        durations: lines(this.durations()).map(Number),
        messages: lines(this.messages()),
      });
      const saved = this.service.presets();
      this.durations.set(saved.durations.join('\n'));
      this.notify.success('Saved.');
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
