import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type {
  CustomFunctionDto,
  FunctionParam,
  RunFunctionResponse,
} from '@cod2admin/miniapp-api';
import { ApiService } from '../core/api';
import { SessionService } from '../core/session';
import { Forms, type FormField, type FormValues } from './form-dialog';
import { Icon } from './icon';
import { T } from './i18n';
import { Notify } from './notify';

type ActionFunction = CustomFunctionDto & {
  definition: { params: FunctionParam[]; steps: string[] };
};

const isAction = (fn: CustomFunctionDto): fn is ActionFunction =>
  fn.kind === 'action' && 'params' in fn.definition;

/** Colour codes (`^1`) are for the game; the picker shows plain names. */
const plain = (name: string) => name.replace(/\^[0-9]/g, '');

/**
 * The buttons for the owner's custom functions (docs/PLAN-custom-functions.md) — what this person
 * may run on the chosen server. Nothing is built here: a tap sends the function and its values, and
 * the bot builds the commands.
 */
@Component({
  selector: 'c2a-custom-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [T, MatButtonModule, Icon],
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
  `,
})
export class CustomActions {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);
  private readonly forms = inject(Forms);
  private readonly notify = inject(Notify);

  protected readonly actions = signal<ActionFunction[]>([]);
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

  private async load(alias: string, allowed: boolean): Promise<void> {
    this.result.set(null);
    if (!alias || !allowed) {
      this.actions.set([]);
      return;
    }
    try {
      const { functions } = await this.api.serverFunctions(alias);
      // Ignore a late answer for a server the person has since left.
      if (alias === this.session.server()) {
        this.actions.set(functions.filter(isAction));
      }
    } catch {
      // The card is optional: a failure here shouldn't get in the way of the page.
      this.actions.set([]);
    }
  }

  protected async run(fn: ActionFunction): Promise<void> {
    const alias = this.session.server();
    this.running.set(true);
    try {
      const values = await this.ask(alias, fn);
      if (values === null) {
        return;
      }
      if (
        fn.dangerous &&
        !(await this.notify.confirm({
          title: fn.title,
          message: fn.description || 'Run this on the server now?',
          confirm: 'Run',
          danger: true,
        }))
      ) {
        return;
      }
      const response = await this.api.runFunction(alias, fn.id, {
        values,
        ...(fn.dangerous ? { confirm: true } : {}),
      });
      this.result.set({ title: fn.title, steps: response.steps });
      this.notify.success(response.message);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.running.set(false);
    }
  }

  /** The values to send, `{}` when there is nothing to ask, `null` when cancelled. */
  private async ask(
    alias: string,
    fn: ActionFunction,
  ): Promise<Record<string, unknown> | null> {
    const { params } = fn.definition;
    if (params.length === 0) {
      return {};
    }
    const needsPlayers = params.some((param) => param.type === 'player');
    const needsMaps = params.some((param) => param.type === 'map');
    const [status, maps] = await Promise.all([
      needsPlayers ? this.api.status(alias) : null,
      needsMaps ? this.api.maps(alias) : null,
    ]);
    const players = status?.players ?? [];
    const fields: FormField[] = params.map((param) => {
      const base = { key: param.name, label: param.label };
      switch (param.type) {
        case 'text':
          return { ...base, required: true };
        case 'number':
          return {
            ...base,
            type: 'number' as const,
            required: true,
            hint: rangeHint(param.min, param.max),
          };
        case 'choice':
          return {
            ...base,
            type: 'select' as const,
            required: true,
            options: param.options,
          };
        case 'bool':
          return { ...base, type: 'checkbox' as const };
        case 'player':
          return {
            ...base,
            type: 'select' as const,
            required: true,
            options: players.map((player) => ({
              value: String(player.num),
              label: `${plain(player.name)} (${player.num})`,
            })),
          };
        case 'map':
          return {
            ...base,
            type: 'select' as const,
            required: true,
            options: (maps?.maps ?? []).map((map) => ({
              value: map.name,
              label: map.name,
            })),
          };
      }
    });
    const answers = await this.forms.open({
      title: fn.title,
      message: fn.description ?? undefined,
      confirm: 'Run',
      fields,
    });
    return answers && toValues(params, answers, players);
  }
}

function rangeHint(min?: number, max?: number): string | undefined {
  if (min !== undefined && max !== undefined) {
    return `${min}–${max}`;
  }
  if (min !== undefined) {
    return `≥ ${min}`;
  }
  return max !== undefined ? `≤ ${max}` : undefined;
}

/** The dialog's strings and checkboxes, as the types the bot expects. */
function toValues(
  params: readonly FunctionParam[],
  answers: FormValues,
  players: readonly { num: number; name: string }[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const param of params) {
    const answer = answers[param.name];
    switch (param.type) {
      case 'number':
        values[param.name] = Number(answer);
        break;
      case 'bool':
        values[param.name] = answer === true;
        break;
      case 'player': {
        // The bot checks the slot still holds this name before it acts.
        const player = players.find((one) => String(one.num) === answer);
        values[param.name] = player && { num: player.num, name: player.name };
        break;
      }
      default:
        values[param.name] = answer;
    }
  }
  return values;
}
