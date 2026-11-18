import { inject, Injectable } from '@angular/core';
import type {
  CustomFunctionDto,
  FunctionParam,
  RunFunctionResponse,
} from '@cod2admin/miniapp-api';
import { ApiService } from '../core/api';
import { Forms, type FormField, type FormValues } from './form-dialog';
import { Notify } from './notify';

/** Colour codes (`^1`) are for the game; the pickers show plain names. */
const plain = (name: string) => name.replace(/\^[0-9]/g, '');

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

/**
 * Runs a custom function for the person using the app (docs/PLAN-custom-functions.md): asks what
 * the function needs, confirms a dangerous one, and sends the function and its values — the bot
 * builds the commands. Shared by the dashboard buttons and the player sheet.
 */
@Injectable({ providedIn: 'root' })
export class FunctionRunner {
  private readonly api = inject(ApiService);
  private readonly forms = inject(Forms);
  private readonly notify = inject(Notify);

  /**
   * An action or player action. `fixed` holds answers already known — a player action is run on a
   * player, so `player` is given. `null` when cancelled or when it failed (the person was told).
   */
  async run(
    alias: string,
    fn: CustomFunctionDto,
    fixed: Record<string, unknown> = {},
  ): Promise<RunFunctionResponse | null> {
    try {
      const asked = await this.ask(alias, fn, fixed);
      if (asked === null || !(await this.confirm(fn))) {
        return null;
      }
      return await this.send(alias, fn, { values: { ...fixed, ...asked } });
    } catch (error) {
      this.notify.error(error);
      return null;
    }
  }

  /** A setting's new value. */
  async set(
    alias: string,
    fn: CustomFunctionDto,
    value: unknown,
  ): Promise<RunFunctionResponse | null> {
    try {
      return (await this.confirm(fn))
        ? await this.send(alias, fn, { value })
        : null;
    } catch (error) {
      this.notify.error(error);
      return null;
    }
  }

  private async confirm(fn: CustomFunctionDto): Promise<boolean> {
    return (
      !fn.dangerous ||
      this.notify.confirm({
        title: fn.title,
        message: fn.description || 'Run this on the server now?',
        confirm: 'Run',
        danger: true,
      })
    );
  }

  private async send(
    alias: string,
    fn: CustomFunctionDto,
    body: { values?: Record<string, unknown>; value?: unknown },
  ): Promise<RunFunctionResponse> {
    const response = await this.api.runFunction(alias, fn.id, {
      ...body,
      ...(fn.dangerous ? { confirm: true } : {}),
    });
    this.notify.success(response.message);
    return response;
  }

  /** The answers to send, `{}` when there is nothing to ask, `null` when cancelled. */
  private async ask(
    alias: string,
    fn: CustomFunctionDto,
    fixed: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const params =
      'params' in fn.definition
        ? fn.definition.params.filter((param) => !(param.name in fixed))
        : [];
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
