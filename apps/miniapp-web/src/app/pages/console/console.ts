import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { ApiService } from '../../core/api';
import { SessionService } from '../../core/session';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';

interface Entry {
  id: number;
  server: string;
  command: string;
  output: string;
}

/** Owner-only raw RCON (docs/PLAN-miniapp.md §6.1) — the app's `/rcon`, logged the same way. */
@Component({
  selector: 'c2a-console-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    Icon,
  ],
  template: `
    <div class="page">
      <form class="prompt" (ngSubmit)="run()">
        <mat-form-field
          class="input"
          subscriptSizing="dynamic"
          appearance="outline"
        >
          <mat-label>RCON command on {{ session.server() }}</mat-label>
          <input
            matInput
            name="command"
            class="mono"
            [(ngModel)]="command"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
        </mat-form-field>
        <button
          mat-flat-button
          type="submit"
          [disabled]="running() || !command().trim()"
        >
          Run
        </button>
      </form>
      <p class="muted small">
        Sent as typed, like /rcon in the chat. Every command goes into the audit
        log.
      </p>

      @for (entry of entries(); track entry.id) {
        <section class="entry">
          <div class="row">
            <span class="mono command">&gt; {{ entry.command }}</span>
            <span class="spacer"></span>
            <span class="muted small">{{ entry.server }}</span>
            <button
              mat-icon-button
              aria-label="Run again"
              (click)="command.set(entry.command)"
            >
              <c2a-icon name="edit" />
            </button>
          </div>
          <pre class="mono">{{ entry.output || '(no output)' }}</pre>
        </section>
      }
    </div>
  `,
  styles: `
    .prompt {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .input {
      flex: 1;
    }
    .small {
      font: var(--mat-sys-body-small);
    }
    .entry {
      margin-top: 12px;
      background: var(--mat-sys-surface-container);
      border-radius: 12px;
      padding: 4px 4px 4px 12px;
    }
    .command {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    pre {
      margin: 0 8px 8px 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 50vh;
      overflow: auto;
    }
  `,
})
export class ConsolePage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  protected readonly session = inject(SessionService);

  protected readonly command = signal('');
  protected readonly running = signal(false);
  protected readonly entries = signal<Entry[]>([]);
  private nextId = 1;

  protected async run(): Promise<void> {
    const command = this.command().trim();
    if (!command) {
      return;
    }
    const server = this.session.server();
    this.running.set(true);
    try {
      const { output } = await this.api.console(server, command);
      this.entries.update((entries) =>
        [{ id: this.nextId++, server, command, output }, ...entries].slice(
          0,
          30,
        ),
      );
      this.command.set('');
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.running.set(false);
    }
  }
}
