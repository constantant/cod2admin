import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import {
  FUNCTION_PACK_FORMAT,
  type ImportFunctionsResponse,
  type CustomFunctionDto,
  type CustomFunctionKind,
  type FunctionParam,
  type Permission,
  type SaveFunctionRequest,
  type SettingControl,
} from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { SessionService } from '../../core/session';
import { Icon } from '../../shared/icon';
import { T } from '../../shared/i18n';
import { Notify } from '../../shared/notify';

type ParamType = FunctionParam['type'];

interface ParamDraft {
  name: string;
  label: string;
  type: ParamType;
  min: string;
  max: string;
  maxLength: string;
  /** One option per line: the value, then its label (`ak47 AK-47`). */
  options: string;
}

type ControlType = SettingControl['type'];

const KINDS: { value: CustomFunctionKind; label: string }[] = [
  { value: 'action', label: 'Button on the dashboard' },
  { value: 'player_action', label: 'Action on a player' },
  { value: 'setting', label: 'Setting' },
];

const CONTROL_TYPES: { value: ControlType; label: string }[] = [
  { value: 'toggle', label: 'On / off' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Choice' },
  { value: 'text', label: 'Text' },
];

interface Draft {
  kind: CustomFunctionKind;
  /** A setting's cvar and how it is shown. */
  cvar: string;
  controlType: ControlType;
  onValue: string;
  offValue: string;
  min: string;
  max: string;
  maxLength: string;
  options: string;
  /** `null` while it is new — the id (slug) can't change afterwards. */
  id: number | null;
  slug: string;
  slugEdited: boolean;
  title: string;
  description: string;
  serverAlias: string;
  requires: string;
  dangerous: boolean;
  enabled: boolean;
  params: ParamDraft[];
  steps: string[];
}

const PARAM_TYPES: { value: ParamType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'choice', label: 'Choice' },
  { value: 'bool', label: 'On / off' },
  { value: 'player', label: 'Player' },
  { value: 'map', label: 'Map' },
];

/** What a function can ask of the person running it, besides `functions.run`. */
const REQUIRES: Permission[] = [
  'kick',
  'tempban',
  'mute',
  'ban',
  'say',
  'maps',
  'presets',
  'vpn',
  'cvars.read',
  'cvars.write',
  'rcon',
];

const slugify = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const blankParam = (): ParamDraft => ({
  name: '',
  label: '',
  type: 'text',
  min: '',
  max: '',
  maxLength: '',
  options: '',
});

const blankDraft = (): Draft => ({
  kind: 'action',
  cvar: '',
  controlType: 'toggle',
  onValue: '',
  offValue: '',
  min: '',
  max: '',
  maxLength: '',
  options: '',
  id: null,
  slug: '',
  slugEdited: false,
  title: '',
  description: '',
  serverAlias: '',
  requires: '',
  dangerous: false,
  enabled: true,
  params: [],
  steps: [''],
});

function optionsText(options: { value: string; label: string }[]): string {
  return options
    .map((option) =>
      option.label === option.value
        ? option.value
        : `${option.value} ${option.label}`,
    )
    .join('\n');
}

function parseOptions(text: string): { value: string; label: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.search(/\s/);
      return space === -1
        ? { value: line, label: line }
        : {
            value: line.slice(0, space),
            label: line.slice(space).trim(),
          };
    });
}

const maybeNumber = (text: string) =>
  text.trim() === '' ? undefined : Number(text);

function paramFromDraft(draft: ParamDraft): FunctionParam {
  const base = { name: draft.name.trim(), label: draft.label.trim() };
  switch (draft.type) {
    case 'text':
      return {
        ...base,
        type: 'text',
        ...(draft.maxLength.trim()
          ? { maxLength: Number(draft.maxLength) }
          : {}),
      };
    case 'number':
      return {
        ...base,
        type: 'number',
        ...(maybeNumber(draft.min) !== undefined
          ? { min: maybeNumber(draft.min) }
          : {}),
        ...(maybeNumber(draft.max) !== undefined
          ? { max: maybeNumber(draft.max) }
          : {}),
      };
    case 'choice':
      return { ...base, type: 'choice', options: parseOptions(draft.options) };
    default:
      return { ...base, type: draft.type };
  }
}

function paramToDraft(param: FunctionParam): ParamDraft {
  const draft: ParamDraft = {
    ...blankParam(),
    name: param.name,
    label: param.label,
    type: param.type,
  };
  if (param.type === 'text' && param.maxLength !== undefined) {
    draft.maxLength = String(param.maxLength);
  }
  if (param.type === 'number') {
    draft.min = param.min === undefined ? '' : String(param.min);
    draft.max = param.max === undefined ? '' : String(param.max);
  }
  if (param.type === 'choice') {
    draft.options = optionsText(param.options);
  }
  return draft;
}

function controlFromDraft(draft: Draft): SettingControl {
  switch (draft.controlType) {
    case 'toggle':
      return {
        type: 'toggle',
        ...(draft.onValue.trim() ? { onValue: draft.onValue.trim() } : {}),
        ...(draft.offValue.trim() ? { offValue: draft.offValue.trim() } : {}),
      };
    case 'number':
      return {
        type: 'number',
        ...(maybeNumber(draft.min) !== undefined
          ? { min: maybeNumber(draft.min) }
          : {}),
        ...(maybeNumber(draft.max) !== undefined
          ? { max: maybeNumber(draft.max) }
          : {}),
      };
    case 'select':
      return { type: 'select', options: parseOptions(draft.options) };
    case 'text':
      return {
        type: 'text',
        ...(draft.maxLength.trim()
          ? { maxLength: Number(draft.maxLength) }
          : {}),
      };
  }
}

function toRequest(draft: Draft): SaveFunctionRequest {
  return {
    slug: draft.slug.trim(),
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    kind: draft.kind,
    definition:
      draft.kind === 'setting'
        ? { cvar: draft.cvar.trim(), control: controlFromDraft(draft) }
        : {
            params: draft.params.map(paramFromDraft),
            steps: draft.steps.map((step) => step.trim()).filter(Boolean),
          },
    serverAlias: draft.serverAlias || null,
    requires: (draft.requires || null) as Permission | null,
    dangerous: draft.dangerous,
    enabled: draft.enabled,
  };
}

function toDraft(fn: CustomFunctionDto): Draft {
  const definition =
    'params' in fn.definition ? fn.definition : { params: [], steps: [] };
  const draft: Draft = {
    ...blankDraft(),
    kind: fn.kind,
    id: fn.id,
    slug: fn.slug,
    slugEdited: true,
    title: fn.title,
    description: fn.description ?? '',
    serverAlias: fn.serverAlias ?? '',
    requires: fn.requires ?? '',
    dangerous: fn.dangerous,
    enabled: fn.enabled,
    params: definition.params.map(paramToDraft),
    steps: definition.steps.length > 0 ? [...definition.steps] : [''],
  };
  if ('cvar' in fn.definition) {
    const { cvar, control } = fn.definition;
    draft.cvar = cvar;
    draft.controlType = control.type;
    if (control.type === 'toggle') {
      draft.onValue = control.onValue ?? '';
      draft.offValue = control.offValue ?? '';
    }
    if (control.type === 'number') {
      draft.min = control.min === undefined ? '' : String(control.min);
      draft.max = control.max === undefined ? '' : String(control.max);
    }
    if (control.type === 'select') {
      draft.options = optionsText(control.options);
    }
    if (control.type === 'text' && control.maxLength !== undefined) {
      draft.maxLength = String(control.maxLength);
    }
  }
  return draft;
}

/** What an export keeps: the definition, not who made it or when. */
function toPackEntry(fn: CustomFunctionDto): SaveFunctionRequest {
  return {
    slug: fn.slug,
    title: fn.title,
    description: fn.description,
    icon: fn.icon,
    kind: fn.kind,
    definition: fn.definition,
    serverAlias: fn.serverAlias,
    requires: fn.requires,
    dangerous: fn.dangerous,
    enabled: fn.enabled,
  };
}

/** A pack pasted or loaded: the wrapper an export writes, or a bare list. `null` if it isn't one. */
function parsePack(text: string): SaveFunctionRequest[] | null {
  try {
    const value: unknown = JSON.parse(text);
    const list = Array.isArray(value)
      ? value
      : value &&
          typeof value === 'object' &&
          (value as { format?: unknown }).format === FUNCTION_PACK_FORMAT
        ? (value as { functions?: unknown }).functions
        : null;
    return Array.isArray(list) && list.length > 0
      ? (list as SaveFunctionRequest[])
      : null;
  } catch {
    return null;
  }
}

/**
 * Where the owner defines custom functions (docs/PLAN-custom-functions.md): RCON command templates
 * for what a mod adds. Needs `functions.manage`. Each one becomes a button on the dashboard.
 */
@Component({
  selector: 'c2a-functions-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    Icon,
  ],
  template: `
    <div class="page">
      @if (draft(); as draft) {
        <h2>
          {{ (draft.id === null ? 'New function' : 'Edit function') | t }}
        </h2>
        <mat-form-field class="full-width" appearance="outline">
          <mat-label>{{ 'Title' | t }}</mat-label>
          <input
            matInput
            name="title"
            maxlength="60"
            [ngModel]="draft.title"
            (ngModelChange)="setTitle($event)"
          />
        </mat-form-field>
        <mat-form-field class="full-width" appearance="outline">
          <mat-label>{{ 'Id' | t }}</mat-label>
          <input
            matInput
            name="slug"
            class="mono"
            maxlength="40"
            [disabled]="draft.id !== null"
            [ngModel]="draft.slug"
            (ngModelChange)="setSlug($event)"
          />
          <mat-hint>{{
            "Lower case letters, digits and -. Can't be changed later." | t
          }}</mat-hint>
        </mat-form-field>
        <mat-form-field class="full-width" appearance="outline">
          <mat-label>{{ 'What it is' | t }}</mat-label>
          <mat-select
            name="kind"
            [(ngModel)]="draft.kind"
            (ngModelChange)="kindChanged()"
          >
            @for (kind of kinds; track kind.value) {
              <mat-option [value]="kind.value">{{ kind.label | t }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field class="full-width" appearance="outline">
          <mat-label>{{ 'Description' | t }}</mat-label>
          <input
            matInput
            name="description"
            maxlength="200"
            [(ngModel)]="draft.description"
          />
        </mat-form-field>
        <mat-form-field class="full-width" appearance="outline">
          <mat-label>{{ 'Servers' | t }}</mat-label>
          <mat-select name="serverAlias" [(ngModel)]="draft.serverAlias">
            <mat-option value="">{{ 'All servers' | t }}</mat-option>
            @for (server of servers(); track server) {
              <mat-option [value]="server">{{ server }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field class="full-width" appearance="outline">
          <mat-label>{{ 'Who may run it' | t }}</mat-label>
          <mat-select name="requires" [(ngModel)]="draft.requires">
            <mat-option value="">{{
              'Anyone who can run functions' | t
            }}</mat-option>
            @for (permission of requires; track permission) {
              <mat-option [value]="permission">{{ permission }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <p>
          <mat-checkbox name="dangerous" [(ngModel)]="draft.dangerous">{{
            'Ask for confirmation before running' | t
          }}</mat-checkbox>
        </p>
        <p>
          <mat-checkbox name="enabled" [(ngModel)]="draft.enabled">{{
            'Enabled' | t
          }}</mat-checkbox>
        </p>

        @if (draft.kind === 'setting') {
          <section class="card">
            <h3>{{ 'What it controls' | t }}</h3>
            <mat-form-field class="full-width" appearance="outline">
              <mat-label>{{ 'Server setting (cvar)' | t }}</mat-label>
              <input
                matInput
                class="mono"
                name="cvar"
                maxlength="64"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                [(ngModel)]="draft.cvar"
              />
            </mat-form-field>
            <mat-form-field class="full-width" appearance="outline">
              <mat-label>{{ 'Shown as' | t }}</mat-label>
              <mat-select name="controlType" [(ngModel)]="draft.controlType">
                @for (type of controlTypes; track type.value) {
                  <mat-option [value]="type.value">{{
                    type.label | t
                  }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            @switch (draft.controlType) {
              @case ('toggle') {
                <div class="row">
                  <mat-form-field
                    class="grow"
                    subscriptSizing="dynamic"
                    appearance="outline"
                  >
                    <mat-label>{{ 'Value when on' | t }}</mat-label>
                    <input
                      matInput
                      class="mono"
                      name="onValue"
                      placeholder="1"
                      [(ngModel)]="draft.onValue"
                    />
                  </mat-form-field>
                  <mat-form-field
                    class="grow"
                    subscriptSizing="dynamic"
                    appearance="outline"
                  >
                    <mat-label>{{ 'Value when off' | t }}</mat-label>
                    <input
                      matInput
                      class="mono"
                      name="offValue"
                      placeholder="0"
                      [(ngModel)]="draft.offValue"
                    />
                  </mat-form-field>
                </div>
              }
              @case ('number') {
                <div class="row">
                  <mat-form-field
                    class="grow"
                    subscriptSizing="dynamic"
                    appearance="outline"
                  >
                    <mat-label>{{ 'Smallest' | t }}</mat-label>
                    <input
                      matInput
                      type="number"
                      name="cmin"
                      [(ngModel)]="draft.min"
                    />
                  </mat-form-field>
                  <mat-form-field
                    class="grow"
                    subscriptSizing="dynamic"
                    appearance="outline"
                  >
                    <mat-label>{{ 'Largest' | t }}</mat-label>
                    <input
                      matInput
                      type="number"
                      name="cmax"
                      [(ngModel)]="draft.max"
                    />
                  </mat-form-field>
                </div>
              }
              @case ('select') {
                <mat-form-field class="full-width" appearance="outline">
                  <mat-label>{{ 'Options' | t }}</mat-label>
                  <textarea
                    matInput
                    rows="3"
                    class="mono"
                    name="copts"
                    [(ngModel)]="draft.options"
                  ></textarea>
                  <mat-hint>{{
                    'One per line: the value, then its label.' | t
                  }}</mat-hint>
                </mat-form-field>
              }
              @case ('text') {
                <mat-form-field
                  class="full-width"
                  subscriptSizing="dynamic"
                  appearance="outline"
                >
                  <mat-label>{{ 'Longest text' | t }}</mat-label>
                  <input
                    matInput
                    type="number"
                    name="clen"
                    [(ngModel)]="draft.maxLength"
                  />
                </mat-form-field>
              }
            }
          </section>
        } @else {
          <section class="card">
            <h3>{{ 'What it asks' | t }}</h3>
            @for (param of draft.params; track $index) {
              <div class="param">
                <div class="row">
                  <mat-form-field
                    class="grow"
                    subscriptSizing="dynamic"
                    appearance="outline"
                  >
                    <mat-label>{{ 'Name' | t }}</mat-label>
                    <input
                      matInput
                      class="mono"
                      [name]="'pname' + $index"
                      maxlength="24"
                      [(ngModel)]="param.name"
                    />
                  </mat-form-field>
                  <mat-form-field
                    class="grow"
                    subscriptSizing="dynamic"
                    appearance="outline"
                  >
                    <mat-label>{{ 'Label' | t }}</mat-label>
                    <input
                      matInput
                      [name]="'plabel' + $index"
                      maxlength="40"
                      [(ngModel)]="param.label"
                    />
                  </mat-form-field>
                  <button
                    mat-icon-button
                    type="button"
                    [attr.aria-label]="'Remove' | t"
                    (click)="removeParam($index)"
                  >
                    <c2a-icon name="delete" />
                  </button>
                </div>
                <mat-form-field
                  class="full-width"
                  subscriptSizing="dynamic"
                  appearance="outline"
                >
                  <mat-label>{{ 'Type' | t }}</mat-label>
                  <mat-select
                    [name]="'ptype' + $index"
                    [(ngModel)]="param.type"
                  >
                    @for (type of paramTypes; track type.value) {
                      <mat-option [value]="type.value">{{
                        type.label | t
                      }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
                @if (param.type === 'number') {
                  <div class="row">
                    <mat-form-field
                      class="grow"
                      subscriptSizing="dynamic"
                      appearance="outline"
                    >
                      <mat-label>{{ 'Smallest' | t }}</mat-label>
                      <input
                        matInput
                        type="number"
                        [name]="'pmin' + $index"
                        [(ngModel)]="param.min"
                      />
                    </mat-form-field>
                    <mat-form-field
                      class="grow"
                      subscriptSizing="dynamic"
                      appearance="outline"
                    >
                      <mat-label>{{ 'Largest' | t }}</mat-label>
                      <input
                        matInput
                        type="number"
                        [name]="'pmax' + $index"
                        [(ngModel)]="param.max"
                      />
                    </mat-form-field>
                  </div>
                }
                @if (param.type === 'text') {
                  <mat-form-field
                    class="full-width"
                    subscriptSizing="dynamic"
                    appearance="outline"
                  >
                    <mat-label>{{ 'Longest text' | t }}</mat-label>
                    <input
                      matInput
                      type="number"
                      [name]="'plen' + $index"
                      [(ngModel)]="param.maxLength"
                    />
                  </mat-form-field>
                }
                @if (param.type === 'choice') {
                  <mat-form-field class="full-width" appearance="outline">
                    <mat-label>{{ 'Options' | t }}</mat-label>
                    <textarea
                      matInput
                      rows="3"
                      class="mono"
                      [name]="'popts' + $index"
                      [(ngModel)]="param.options"
                    ></textarea>
                    <mat-hint>{{
                      'One per line: the value, then its label.' | t
                    }}</mat-hint>
                  </mat-form-field>
                }
              </div>
            }
            <button mat-button type="button" (click)="addParam()">
              <c2a-icon name="add" /> {{ 'Add a question' | t }}
            </button>
          </section>

          <section class="card">
            <h3>{{ 'What it sends' | t }}</h3>
            <p class="muted small">
              {{
                'One RCON command per step, run in order. Write {name} where an answer goes: text is quoted for you.'
                  | t
              }}
            </p>
            @for (step of draft.steps; track $index) {
              <div class="row">
                <mat-form-field
                  class="grow"
                  subscriptSizing="dynamic"
                  appearance="outline"
                >
                  <input
                    matInput
                    class="mono"
                    [name]="'step' + $index"
                    maxlength="512"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    [(ngModel)]="draft.steps[$index]"
                  />
                </mat-form-field>
                <button
                  mat-icon-button
                  type="button"
                  [attr.aria-label]="'Remove' | t"
                  [disabled]="draft.steps.length === 1"
                  (click)="removeStep($index)"
                >
                  <c2a-icon name="delete" />
                </button>
              </div>
            }
            <button
              mat-button
              type="button"
              [disabled]="draft.steps.length >= 5"
              (click)="addStep()"
            >
              <c2a-icon name="add" /> {{ 'Add a step' | t }}
            </button>
          </section>
        }

        <section class="card">
          <h3>{{ 'Try it' | t }}</h3>
          @if (hasPlayerParam()) {
            <p class="muted small">
              {{
                'Anything that needs a player can only be tried once it is saved, with a player picked.'
                  | t
              }}
            </p>
          } @else {
            @if (draft.kind === 'setting') {
              @if (draft.controlType === 'toggle') {
                <p>
                  <mat-checkbox
                    name="sampleValue"
                    [ngModel]="samples()['__value'] === true"
                    (ngModelChange)="setSample('__value', $event)"
                    >{{ 'On' | t }}</mat-checkbox
                  >
                </p>
              } @else {
                <mat-form-field
                  class="full-width"
                  subscriptSizing="dynamic"
                  appearance="outline"
                >
                  <mat-label>{{ 'Value' | t }}</mat-label>
                  <input
                    matInput
                    name="sampleValue"
                    [ngModel]="samples()['__value'] ?? ''"
                    (ngModelChange)="setSample('__value', $event)"
                  />
                </mat-form-field>
              }
            } @else {
              @for (param of draft.params; track $index) {
                @if (param.name) {
                  @switch (param.type) {
                    @case ('bool') {
                      <p>
                        <mat-checkbox
                          [name]="'sample' + $index"
                          [ngModel]="samples()[param.name] === true"
                          (ngModelChange)="setSample(param.name, $event)"
                          >{{ param.label || param.name }}</mat-checkbox
                        >
                      </p>
                    }
                    @default {
                      <mat-form-field
                        class="full-width"
                        subscriptSizing="dynamic"
                        appearance="outline"
                      >
                        <mat-label>{{ param.label || param.name }}</mat-label>
                        <input
                          matInput
                          [name]="'sample' + $index"
                          [ngModel]="samples()[param.name] ?? ''"
                          (ngModelChange)="setSample(param.name, $event)"
                        />
                      </mat-form-field>
                    }
                  }
                }
              }
            }
            <button
              mat-button
              type="button"
              [disabled]="busy()"
              (click)="preview()"
            >
              {{ 'Show the commands' | t }}
            </button>
            @for (command of previewed(); track $index) {
              <div class="mono command">&gt; {{ command }}</div>
            }
          }
          <p class="muted small">
            {{ 'Nothing is sent to the server from here.' | t }}
          </p>
        </section>

        <div class="row actions">
          <button
            mat-button
            type="button"
            [disabled]="busy()"
            (click)="cancel()"
          >
            {{ 'Cancel' | t }}
          </button>
          <span class="spacer"></span>
          <button
            mat-flat-button
            type="button"
            [disabled]="busy()"
            (click)="save()"
          >
            {{ 'Save' | t }}
          </button>
        </div>
      } @else if (panel() === 'export') {
        <h2>{{ 'Export' | t }}</h2>
        <p class="muted small">
          {{
            'Copy this and paste it into Import on another bot, or keep it as a backup.'
              | t
          }}
        </p>
        @for (fn of functions(); track fn.id) {
          <p>
            <mat-checkbox
              [name]="'export' + fn.id"
              [ngModel]="exportIds().has(fn.id)"
              (ngModelChange)="toggleExport(fn.id, $event)"
              >{{ fn.title }}</mat-checkbox
            >
          </p>
        }
        <mat-form-field class="full-width" appearance="outline">
          <textarea
            matInput
            rows="10"
            class="mono"
            name="exportText"
            readonly
            [value]="exportText()"
          ></textarea>
        </mat-form-field>
        <div class="row actions">
          <button mat-button type="button" (click)="closePanel()">
            {{ 'Back' | t }}
          </button>
          <span class="spacer"></span>
          <button
            mat-flat-button
            type="button"
            [disabled]="exportIds().size === 0"
            (click)="copyExport()"
          >
            {{ 'Copy' | t }}
          </button>
        </div>
      } @else if (panel() === 'import') {
        <h2>{{ 'Import' | t }}</h2>
        <p class="muted small">
          {{
            'Paste a pack, or choose its file. Look it over before you import it: every step is a command your server will run.'
              | t
          }}
        </p>
        <mat-form-field class="full-width" appearance="outline">
          <textarea
            matInput
            rows="8"
            class="mono"
            name="importText"
            spellcheck="false"
            [ngModel]="importText()"
            (ngModelChange)="setImportText($event)"
          ></textarea>
        </mat-form-field>
        <input
          type="file"
          accept=".json,application/json"
          (change)="chooseFile($event)"
        />
        <p>
          <mat-checkbox
            name="importReplace"
            [ngModel]="importReplace()"
            (ngModelChange)="setImportReplace($event)"
            >{{
              'Replace functions I already have with the same id' | t
            }}</mat-checkbox
          >
        </p>
        @if (importCheck(); as check) {
          @for (result of check.results; track result.slug) {
            <section class="card">
              <div class="title">{{ result.title }}</div>
              <div class="muted small">
                <span class="mono">{{ result.slug }}</span>
                · {{ statusLabel(result.status) | t }}
              </div>
              @if (result.note) {
                <div class="muted small">{{ result.note }}</div>
              }
              @for (step of importSteps(result.slug); track $index) {
                <div class="mono command">&gt; {{ step }}</div>
              }
            </section>
          }
        }
        <div class="row actions">
          <button mat-button type="button" (click)="closePanel()">
            {{ 'Back' | t }}
          </button>
          <span class="spacer"></span>
          @if (importCheck()) {
            <button
              mat-flat-button
              type="button"
              [disabled]="busy()"
              (click)="runImport()"
            >
              {{ 'Import' | t }}
            </button>
          } @else {
            <button
              mat-flat-button
              type="button"
              [disabled]="busy() || !importText().trim()"
              (click)="checkImport()"
            >
              {{ 'Check' | t }}
            </button>
          }
        </div>
      } @else {
        <p class="muted small">
          {{
            "Describe what your server's mod adds — a command, say — and it becomes a button on the dashboard."
              | t
          }}
        </p>
        <div class="row">
          <button mat-flat-button type="button" (click)="create()">
            <c2a-icon name="add" /> {{ 'New function' | t }}
          </button>
          <button mat-button type="button" (click)="openImport()">
            {{ 'Import' | t }}
          </button>
          <button
            mat-button
            type="button"
            [disabled]="functions().length === 0"
            (click)="openExport()"
          >
            {{ 'Export' | t }}
          </button>
        </div>
        @if (loaded() && functions().length === 0) {
          <p class="muted">{{ 'No custom functions yet.' | t }}</p>
        }
        @for (fn of functions(); track fn.id) {
          <section class="card item" [class.off]="!fn.enabled">
            <div class="row">
              <div class="grow">
                <div class="title">{{ fn.title }}</div>
                <div class="muted small">
                  <span class="mono">{{ fn.slug }}</span>
                  · {{ fn.serverAlias ?? 'All servers' | t }}
                  @if (!fn.enabled) {
                    · {{ 'Disabled' | t }}
                  }
                </div>
              </div>
              <button
                mat-icon-button
                type="button"
                [attr.aria-label]="'Edit' | t"
                (click)="edit(fn)"
              >
                <c2a-icon name="edit" />
              </button>
              <button
                mat-icon-button
                type="button"
                [attr.aria-label]="'Delete' | t"
                (click)="remove(fn)"
              >
                <c2a-icon name="delete" />
              </button>
            </div>
          </section>
        }
      }
    </div>
  `,
  styles: `
    h2 {
      font: var(--mat-sys-title-medium);
      margin: 0 0 12px;
    }
    h3 {
      font: var(--mat-sys-title-small);
      margin: 0 0 8px;
    }
    .small {
      font: var(--mat-sys-body-small);
      margin: 4px 0 8px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .grow {
      flex: 1;
      min-width: 0;
    }
    .param {
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      padding: 8px 0 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .card {
      margin: 12px 0;
    }
    .item .title {
      font: var(--mat-sys-title-small);
      overflow-wrap: anywhere;
    }
    .off {
      opacity: 0.6;
    }
    .mono {
      font-family: monospace;
    }
    .command {
      overflow-wrap: anywhere;
      margin: 2px 0;
    }
    .actions {
      margin-bottom: 24px;
    }
    .spacer {
      flex: 1;
    }
  `,
})
export class FunctionsPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);
  private readonly notify = inject(Notify);

  /** Export and import work on the whole list, so they replace it while open. */
  protected readonly panel = signal<'export' | 'import' | null>(null);
  protected readonly exportIds = signal<ReadonlySet<number>>(new Set());
  protected readonly exportText = computed(() =>
    JSON.stringify(
      {
        format: FUNCTION_PACK_FORMAT,
        version: 1,
        functions: this.functions()
          .filter((fn) => this.exportIds().has(fn.id))
          .map(toPackEntry),
      },
      null,
      2,
    ),
  );
  protected readonly importText = signal('');
  protected readonly importReplace = signal(false);
  /** What a check of the pasted pack found; cleared whenever the text or the choice changes. */
  protected readonly importCheck = signal<ImportFunctionsResponse | null>(null);
  protected readonly kinds = KINDS;
  protected readonly controlTypes = CONTROL_TYPES;
  protected readonly paramTypes = PARAM_TYPES;
  protected readonly requires = REQUIRES;
  protected readonly functions = signal<CustomFunctionDto[]>([]);
  protected readonly loaded = signal(false);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly busy = signal(false);
  protected readonly samples = signal<Record<string, string | boolean>>({});
  protected readonly previewed = signal<string[]>([]);
  protected readonly servers = computed(
    () => this.session.me()?.servers.map((server) => server.alias) ?? [],
  );
  /** A player is picked from the live list, so it can't be tried here. */
  protected readonly hasPlayerParam = computed(() => {
    const draft = this.draft();
    return (
      draft !== null &&
      draft.kind !== 'setting' &&
      (draft.kind === 'player_action' ||
        draft.params.some((param) => param.type === 'player'))
    );
  });

  ngOnInit(): void {
    void this.load();
  }

  /** What was typed for the old kind is kept, but the preview starts over. */
  protected kindChanged(): void {
    this.previewed.set([]);
    this.draft.update((draft) => draft && { ...draft });
  }

  protected openExport(): void {
    this.exportIds.set(new Set(this.functions().map((fn) => fn.id)));
    this.panel.set('export');
  }

  protected openImport(): void {
    this.importText.set('');
    this.importCheck.set(null);
    this.panel.set('import');
  }

  protected closePanel(): void {
    this.panel.set(null);
  }

  protected toggleExport(id: number, on: boolean): void {
    this.exportIds.update((ids) => {
      const next = new Set(ids);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  protected async copyExport(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.exportText());
      this.notify.success('Copied.');
    } catch {
      // Some WebViews block the clipboard: the text is on screen to select by hand.
      this.notify.info('Select the text and copy it by hand.');
    }
  }

  protected setImportText(text: string): void {
    this.importText.set(text);
    this.importCheck.set(null);
  }

  protected setImportReplace(on: boolean): void {
    this.importReplace.set(on);
    this.importCheck.set(null);
  }

  protected async chooseFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) {
      this.setImportText(await file.text());
    }
  }

  /** Asks the bot what the pack would do, without saving anything. */
  protected async checkImport(): Promise<void> {
    await this.sendImport(true);
  }

  protected async runImport(): Promise<void> {
    if (await this.sendImport(false)) {
      this.notify.success('Imported.');
      this.panel.set(null);
      await this.load();
    }
  }

  protected importSteps(slug: string): string[] {
    const entry = parsePack(this.importText())?.find(
      (candidate) => candidate.slug === slug,
    );
    if (!entry) {
      return [];
    }
    return 'steps' in entry.definition
      ? entry.definition.steps
      : [`set ${entry.definition.cvar} …`];
  }

  protected statusLabel(
    status: ImportFunctionsResponse['results'][number]['status'],
  ): string {
    return status === 'created'
      ? 'New'
      : status === 'updated'
        ? 'Replaces the one you have'
        : 'Already here: kept as it is';
  }

  private async sendImport(dryRun: boolean): Promise<boolean> {
    const functions = parsePack(this.importText());
    if (!functions) {
      this.notify.info("That isn't a function pack.");
      return false;
    }
    this.busy.set(true);
    try {
      const response = await this.api.importFunctions({
        functions,
        dryRun,
        onConflict: this.importReplace() ? 'replace' : 'skip',
      });
      if (dryRun) {
        this.importCheck.set(response);
      }
      return true;
    } catch (error) {
      this.importCheck.set(null);
      this.notify.error(error);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  protected create(): void {
    this.open(blankDraft());
  }

  protected edit(fn: CustomFunctionDto): void {
    this.open(toDraft(fn));
  }

  protected cancel(): void {
    this.draft.set(null);
  }

  protected setTitle(title: string): void {
    const draft = this.draft();
    if (!draft) {
      return;
    }
    draft.title = title;
    if (draft.id === null && !draft.slugEdited) {
      draft.slug = slugify(title);
    }
  }

  protected setSlug(slug: string): void {
    const draft = this.draft();
    if (draft) {
      draft.slug = slug;
      draft.slugEdited = true;
    }
  }

  protected addParam(): void {
    this.change((draft) => draft.params.push(blankParam()));
  }

  protected removeParam(index: number): void {
    this.change((draft) => draft.params.splice(index, 1));
  }

  protected addStep(): void {
    this.change((draft) => draft.steps.push(''));
  }

  protected removeStep(index: number): void {
    this.change((draft) => draft.steps.splice(index, 1));
  }

  protected setSample(name: string, value: string | boolean): void {
    this.samples.update((samples) => ({ ...samples, [name]: value }));
  }

  protected async preview(): Promise<void> {
    const draft = this.draft();
    if (!draft) {
      return;
    }
    this.busy.set(true);
    try {
      const request = toRequest(draft);
      const samples = this.samples();
      const values: Record<string, unknown> = {};
      for (const param of draft.params) {
        const sample = samples[param.name];
        values[param.name] =
          param.type === 'number'
            ? Number(sample)
            : param.type === 'bool'
              ? sample === true
              : (sample ?? '');
      }
      const sample = samples['__value'];
      const { commands } = await this.api.previewFunction({
        function: request,
        values,
        ...(draft.kind === 'setting'
          ? {
              value:
                draft.controlType === 'toggle'
                  ? sample === true
                  : draft.controlType === 'number'
                    ? Number(sample)
                    : (sample ?? ''),
            }
          : {}),
        server: this.session.server() || undefined,
      });
      this.previewed.set(commands);
    } catch (error) {
      this.previewed.set([]);
      this.notify.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async save(): Promise<void> {
    const draft = this.draft();
    if (!draft) {
      return;
    }
    this.busy.set(true);
    try {
      const request = toRequest(draft);
      if (draft.id === null) {
        await this.api.createFunction(request);
      } else {
        await this.api.updateFunction(draft.id, request);
      }
      this.notify.success('Saved.');
      this.draft.set(null);
      await this.load();
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(fn: CustomFunctionDto): Promise<void> {
    const sure = await this.notify.confirm({
      title: 'Delete this function?',
      message: `${fn.title} will disappear from the dashboard. What it did stays in the audit log.`,
      confirm: 'Delete',
      danger: true,
    });
    if (!sure) {
      return;
    }
    try {
      await this.api.deleteFunction(fn.id);
      this.notify.success('Deleted.');
      await this.load();
    } catch (error) {
      this.notify.error(error);
    }
  }

  private open(draft: Draft): void {
    this.samples.set({});
    this.previewed.set([]);
    this.draft.set(draft);
  }

  /** Edits the draft in place (the form fields do too), then lets the view know. */
  private change(edit: (draft: Draft) => void): void {
    const draft = this.draft();
    if (draft) {
      edit(draft);
      this.draft.set({ ...draft });
    }
  }

  private async load(): Promise<void> {
    try {
      this.functions.set((await this.api.functions()).functions);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loaded.set(true);
    }
  }
}
