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
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import type {
  CustomFunctionDto,
  RunFunctionResponse,
  SettingControl,
} from '@cod2admin/miniapp-api';
import { ApiService } from '../core/api';
import { SessionService } from '../core/session';
import { FunctionRunner } from './function-runner';
import { Icon } from './icon';
import { T } from './i18n';

type Setting = CustomFunctionDto & {
  definition: { cvar: string; control: SettingControl };
};

const isAction = (fn: CustomFunctionDto) =>
  fn.kind === 'action' && 'params' in fn.definition;
const isSetting = (fn: CustomFunctionDto): fn is Setting =>
  fn.kind === 'setting' && 'cvar' in fn.definition;

/**
 * The owner's custom functions (docs/PLAN-custom-functions.md) on the dashboard: buttons for the
 * actions, and a control for each setting that shows what the server has now. Nothing is built
 * here: a tap sends the function and its values, and the bot builds the commands.
 */
@Component({
  selector: 'c2a-custom-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    Icon,
  ],
  template: `
    @if (actions().length > 0) {
      <section class="card">
        <h2>{{ 'Custom' | t }}</h2>
        <div class="buttons">
          @for (fn of actions(); track fn.id) {
            <button
              mat-tonal-button
              type="button"
              [disabled]="running()"
              [title]="fn.description ?? ''"
              (click)="run(fn)"
            >
              <c2a-icon [name]="fn.dangerous ? 'warning' : 'bolt'" />
              {{ fn.title }}
            </button>
          }
        </div>
        @if (result(); as result) {
          <p class="muted small">{{ result.title }}</p>
          @for (step of result.steps; track $index) {
            <div class="step">
              <span class="mono">&gt; {{ step.command }}</span>
              @if (step.output) {
                <pre class="mono">{{ step.output }}</pre>
              }
            </div>
          }
        }
      </section>
    }
    @if (settings().length > 0) {
      <section class="card">
        <h2>{{ 'Custom settings' | t }}</h2>
        @for (fn of settings(); track fn.id) {
          <div class="setting">
            <div class="label">
              <div>{{ fn.title }}</div>
              @if (fn.description) {
                <div class="muted small">{{ fn.description }}</div>
              }
              @if (values()[fn.id] === null) {
                <div class="muted small">
                  {{ "The server didn't say what it is set to." | t }}
                </div>
              }
            </div>
            @switch (fn.definition.control.type) {
              @case ('toggle') {
                <mat-slide-toggle
                  [checked]="drafts()[fn.id] === 'on'"
                  [disabled]="running()"
                  (change)="apply(fn, $event.checked)"
                />
              }
              @case ('select') {
                <mat-form-field
                  subscriptSizing="dynamic"
                  appearance="outline"
                  class="control"
                >
                  <mat-select
                    [value]="drafts()[fn.id]"
                    [disabled]="running()"
                    (valueChange)="apply(fn, $event)"
                  >
                    @for (option of options(fn); track option.value) {
                      <mat-option [value]="option.value">{{
                        option.label
                      }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
              }
              @default {
                <mat-form-field
                  subscriptSizing="dynamic"
                  appearance="outline"
                  class="control"
                >
                  <input
                    matInput
                    [name]="'setting' + fn.id"
                    [type]="
                      fn.definition.control.type === 'number'
                        ? 'number'
                        : 'text'
                    "
                    autocomplete="off"
                    [ngModel]="drafts()[fn.id] ?? ''"
                    (ngModelChange)="draft(fn, $event)"
                    (keyup.enter)="apply(fn, drafts()[fn.id])"
                  />
                </mat-form-field>
                <button
                  mat-button
                  type="button"
                  [disabled]="running() || !changed(fn)"
                  (click)="apply(fn, drafts()[fn.id])"
                >
                  {{ 'Set' | t }}
                </button>
              }
            }
          </div>
        }
      </section>
    }
  `,
  styles: `
    h2 {
      font: var(--mat-sys-title-small);
      margin: 0 0 8px;
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .small {
      font: var(--mat-sys-body-small);
      margin: 12px 0 4px;
    }
    .setting .small {
      margin: 0;
    }
    .step {
      margin-bottom: 4px;
    }
    .mono {
      font-family: monospace;
      overflow-wrap: anywhere;
    }
    pre {
      margin: 2px 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 30vh;
      overflow: auto;
    }
    .setting {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
    }
    .label {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .control {
      width: 150px;
    }
  `,
})
export class CustomActions {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);
  private readonly runner = inject(FunctionRunner);

  protected readonly actions = signal<CustomFunctionDto[]>([]);
  protected readonly settings = signal<Setting[]>([]);
  /** What the server has now, by function id; `null` when it didn't say. */
  protected readonly values = signal<Record<string, string | null>>({});
  /** What each control shows: a toggle as `on`/`off`, the rest as the value itself. */
  protected readonly drafts = signal<Record<string, string>>({});
  protected readonly running = signal(false);
  protected readonly result = signal<{
    title: string;
    steps: RunFunctionResponse['steps'];
  } | null>(null);

  constructor() {
    effect(() => {
      const alias = this.session.server();
      const allowed = this.session.can('functions.run');
      untracked(() => void this.load(alias, allowed));
    });
  }

  protected options(fn: Setting) {
    const { control } = fn.definition;
    return control.type === 'select' ? control.options : [];
  }

  protected changed(fn: Setting): boolean {
    return (this.drafts()[fn.id] ?? '') !== (this.values()[fn.id] ?? '');
  }

  protected draft(fn: Setting, value: string): void {
    this.drafts.update((drafts) => ({ ...drafts, [fn.id]: String(value) }));
  }

  protected async run(fn: CustomFunctionDto): Promise<void> {
    this.running.set(true);
    try {
      const response = await this.runner.run(this.session.server(), fn);
      if (response) {
        this.result.set({ title: fn.title, steps: response.steps });
      }
    } finally {
      this.running.set(false);
    }
  }

  /** A toggle sends a boolean, a number its number, everything else the text. */
  protected async apply(fn: Setting, value: string | boolean): Promise<void> {
    const { control } = fn.definition;
    const send = control.type === 'number' ? Number(value) : value;
    this.running.set(true);
    try {
      const response = await this.runner.set(this.session.server(), fn, send);
      if (response) {
        const shown =
          control.type === 'toggle' ? (value ? 'on' : 'off') : String(value);
        // Remember what was set: the server's own spelling of it can differ (`1.0` for `1`).
        this.values.update((values) => ({ ...values, [fn.id]: shown }));
        this.draft(fn, shown);
      } else {
        this.reset(fn);
      }
    } finally {
      this.running.set(false);
    }
  }

  private reset(fn: Setting): void {
    this.draft(fn, this.shownValue(fn, this.values()[fn.id] ?? null));
  }

  /** The server's value as the control shows it: a toggle compares it with its on-value. */
  private shownValue(fn: Setting, value: string | null): string {
    const { control } = fn.definition;
    if (control.type === 'toggle') {
      return value === (control.onValue ?? '1') ? 'on' : 'off';
    }
    return value ?? '';
  }

  private async load(alias: string, allowed: boolean): Promise<void> {
    this.result.set(null);
    if (!alias || !allowed) {
      this.actions.set([]);
      this.settings.set([]);
      return;
    }
    try {
      const { functions } = await this.api.serverFunctions(alias);
      // Ignore a late answer for a server the person has since left.
      if (alias !== this.session.server()) {
        return;
      }
      this.actions.set(functions.filter(isAction));
      const settings = functions.filter(isSetting);
      this.settings.set(settings);
      if (settings.length > 0) {
        const { values } = await this.api.functionValues(alias);
        if (alias === this.session.server()) {
          this.values.set(values);
          this.drafts.set(
            Object.fromEntries(
              settings.map((fn) => [
                fn.id,
                this.shownValue(fn, values[fn.id] ?? null),
              ]),
            ),
          );
        }
      }
    } catch {
      // The cards are optional: a failure here shouldn't get in the way of the page.
    }
  }
}
