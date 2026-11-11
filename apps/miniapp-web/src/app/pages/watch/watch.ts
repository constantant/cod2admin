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
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import {
  MatSlideToggleModule,
  type MatSlideToggleChange,
} from '@angular/material/slide-toggle';
import type {
  GameBotResponse,
  GameBotUpdate,
  WatchBotJoin,
  WatchBotMode,
  WatchEvidenceDto,
} from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { SessionService } from '../../core/session';
import { formatAgo } from '../../shared/format';
import { Notify } from '../../shared/notify';
import { T } from '../../shared/i18n';

/** Game bot for the selected server, plus the scores it stored. */
@Component({
  selector: 'c2a-watch-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatSlideToggleModule,
  ],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <div class="page">
      <h2>{{ 'Game bot' | t }}</h2>
      @if (session.can('watch.manage')) {
        @if (bot(); as bot) {
          <section class="card bot">
            <mat-slide-toggle
              [checked]="bot.enabled"
              [disabled]="busy()"
              (change)="setEnabled($event)"
              >{{ 'Game bot is on' | t }}</mat-slide-toggle
            >
            <p class="muted small">
              {{
                'Connects a spectator on this server. The mode says whether it stays quiet, flags, reports, or kicks.'
                  | t
              }}
            </p>
            @if (draft) {
              <form class="fields" (ngSubmit)="saveSettings()">
                <mat-form-field
                  class="span"
                  subscriptSizing="dynamic"
                  appearance="outline"
                >
                  <mat-label>{{ 'Bot name' | t }}</mat-label>
                  <input
                    matInput
                    name="spectatorName"
                    maxlength="32"
                    [disabled]="busy()"
                    [(ngModel)]="draft.spectatorName"
                  />
                </mat-form-field>
                <p class="muted small span">
                  {{
                    'Players see this name. A new name reconnects the bot.' | t
                  }}
                </p>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Mode' | t }}</mat-label>
                  <mat-select
                    name="mode"
                    [disabled]="busy()"
                    [(ngModel)]="draft.mode"
                  >
                    <mat-option value="off">{{ 'Off' | t }}</mat-option>
                    <mat-option value="flag">{{ 'Flag' | t }}</mat-option>
                    <mat-option value="report">{{ 'Report' | t }}</mat-option>
                    <mat-option value="kick">{{ 'Kick' | t }}</mat-option>
                  </mat-select>
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Join' | t }}</mat-label>
                  <mat-select
                    name="join"
                    [disabled]="busy()"
                    [(ngModel)]="draft.join"
                  >
                    <mat-option value="spectator">{{
                      'Spectator' | t
                    }}</mat-option>
                    <mat-option value="private">{{
                      'Private slot' | t
                    }}</mat-option>
                  </mat-select>
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Confirmed aim features' | t }}</mat-label>
                  <mat-select
                    name="confirmedAimFeatures"
                    [disabled]="busy()"
                    [(ngModel)]="draft.confirmedAimFeatures"
                  >
                    <mat-option [value]="0">0</mat-option>
                    <mat-option [value]="1">1</mat-option>
                    <mat-option [value]="2">2</mat-option>
                  </mat-select>
                </mat-form-field>
                @if (kickBlocked()) {
                  <p class="muted small span">
                    {{ 'Kick needs two confirmed aim features.' | t }}
                  </p>
                }
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Flag score' | t }}</mat-label>
                  <input
                    matInput
                    type="number"
                    name="flagZ"
                    step="any"
                    min="0"
                    [disabled]="busy()"
                    [(ngModel)]="draft.flagZ"
                  />
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Kick score' | t }}</mat-label>
                  <input
                    matInput
                    type="number"
                    name="kickZ"
                    step="any"
                    min="0"
                    [disabled]="busy()"
                    [(ngModel)]="draft.kickZ"
                  />
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Samples needed' | t }}</mat-label>
                  <input
                    matInput
                    type="number"
                    name="minFeatureN"
                    step="1"
                    min="0"
                    [disabled]="busy()"
                    [(ngModel)]="draft.minFeatureN"
                  />
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Lives of this player' | t }}</mat-label>
                  <input
                    matInput
                    type="number"
                    name="minSelfLives"
                    step="1"
                    min="0"
                    [disabled]="busy()"
                    [(ngModel)]="draft.minSelfLives"
                  />
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Extreme lives' | t }}</mat-label>
                  <input
                    matInput
                    type="number"
                    name="kickExtremeLives"
                    step="1"
                    min="0"
                    [disabled]="busy()"
                    [(ngModel)]="draft.kickExtremeLives"
                  />
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Session lives' | t }}</mat-label>
                  <input
                    matInput
                    type="number"
                    name="kickMinSessionLives"
                    step="1"
                    min="0"
                    [disabled]="busy()"
                    [(ngModel)]="draft.kickMinSessionLives"
                  />
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Cooldown (ms)' | t }}</mat-label>
                  <input
                    matInput
                    type="number"
                    name="cooldownMs"
                    step="1"
                    min="0"
                    [disabled]="busy()"
                    [(ngModel)]="draft.cooldownMs"
                  />
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Kicks per hour' | t }}</mat-label>
                  <input
                    matInput
                    type="number"
                    name="maxKicksPerHour"
                    step="1"
                    min="0"
                    [disabled]="busy()"
                    [(ngModel)]="draft.maxKicksPerHour"
                  />
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Cards per hour' | t }}</mat-label>
                  <input
                    matInput
                    type="number"
                    name="maxCardsPerHour"
                    step="1"
                    min="0"
                    [disabled]="busy()"
                    [(ngModel)]="draft.maxCardsPerHour"
                  />
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Private slots before' | t }}</mat-label>
                  <input
                    matInput
                    name="privateClientsPrevious"
                    inputmode="numeric"
                    [disabled]="busy()"
                    [(ngModel)]="draft.privateClientsPrevious"
                  />
                </mat-form-field>
                <mat-form-field subscriptSizing="dynamic" appearance="outline">
                  <mat-label>{{ 'Protocol' | t }}</mat-label>
                  <input
                    matInput
                    name="negotiatedProtocol"
                    inputmode="numeric"
                    [disabled]="busy()"
                    [(ngModel)]="draft.negotiatedProtocol"
                  />
                </mat-form-field>
                <p class="muted small span">
                  {{ 'Blank leaves an optional number unset.' | t }}
                </p>
                @switch (bot.privatePassword) {
                  @case ('owned') {
                    <p class="muted small span">
                      {{
                        'The bot generated the private password. /watch password in a private chat shows it.'
                          | t
                      }}
                    </p>
                  }
                  @case ('adopted') {
                    <p class="muted small span">
                      {{
                        'The server already had a private password. The bot kept it.'
                          | t
                      }}
                    </p>
                  }
                  @default {
                    <p class="muted small span">
                      {{
                        'No private password yet. The bot creates one when it reserves a slot.'
                          | t
                      }}
                    </p>
                  }
                }
                <button
                  mat-stroked-button
                  class="full-width span"
                  type="submit"
                  [disabled]="saveDisabled()"
                >
                  {{ 'Save' | t }}
                </button>
              </form>
            }
          </section>
        }
      }

      <h2>{{ 'Watch evidence' | t }}</h2>
      <p class="muted small">
        {{
          'Scores and reasons the watcher stored for this server. The angle window is empty until a later change sends one.'
            | t
        }}
      </p>
      @for (row of items(); track row.id) {
        <section class="card evidence">
          <div class="row">
            <span class="action">{{ row.action }}</span>
            <span class="spacer"></span>
            <span class="muted small">{{ ago(row.createdAt) }}</span>
          </div>
          <div class="small">
            {{ 'Life score' | t }} {{ score(row.lifeScore) }}
            @if (row.reason) {
              · {{ row.reason }}
            }
          </div>
          <div class="small">
            <span class="muted">{{ 'Profile' | t }}</span>
            <span class="mono">{{ row.profileKey }}</span>
          </div>
          @if (featureLine(row); as line) {
            <div class="small mono">{{ line }}</div>
          }
          @if (row.trace === null || row.trace === undefined) {
            <p class="muted small trace">{{ 'No angle trace stored.' | t }}</p>
          } @else {
            <pre class="mono">{{ traceJson(row.trace) }}</pre>
          }
        </section>
      } @empty {
        @if (!loading()) {
          <p class="empty">
            {{ 'No watch evidence on this server yet.' | t }}
          </p>
        }
      }
      @if (more()) {
        <button
          mat-button
          class="full-width"
          (click)="load(session.server(), true)"
        >
          {{ 'Show more' | t }}
        </button>
      }
    </div>
  `,
  styles: `
    h2 {
      margin: 0 0 8px;
      font: var(--mat-sys-title-medium);
    }
    .small {
      font: var(--mat-sys-body-small);
      overflow-wrap: anywhere;
    }
    .bot {
      margin-bottom: 20px;
    }
    .fields {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }
    .span {
      grid-column: 1 / -1;
    }
    @media (min-width: 720px) {
      .fields {
        grid-template-columns: 1fr 1fr;
      }
    }
    .evidence {
      margin-bottom: 10px;
    }
    .action {
      font: var(--mat-sys-label-large);
    }
    .trace {
      margin: 8px 0 0;
    }
    pre {
      margin: 8px 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
})
export class WatchPage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  protected readonly session = inject(SessionService);

  protected readonly items = signal<WatchEvidenceDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly more = signal(false);
  protected readonly bot = signal<GameBotResponse | null>(null);
  protected readonly busy = signal(false);
  protected draft: BotDraft | null = null;

  constructor() {
    effect(() => {
      const alias = this.session.server();
      const manage = this.session.can('watch.manage');
      untracked(() => {
        this.items.set([]);
        this.more.set(false);
        this.bot.set(null);
        this.draft = null;
        void this.load(alias);
        if (manage) {
          void this.loadBot(alias);
        }
      });
    });
  }

  protected ago(iso: string): string {
    return formatAgo(iso);
  }

  protected score(value: number): string {
    if (!Number.isFinite(value)) return '';
    return String(Math.round(value * 100) / 100);
  }

  protected featureLine(row: WatchEvidenceDto): string {
    return Object.entries(row.features)
      .filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      )
      .map(([name, value]) => `${name} ${this.score(value)}`)
      .join(' · ');
  }

  /** Whatever was stored. Null is rendered by the template, not replaced. */
  protected traceJson(trace: unknown): string {
    return JSON.stringify(trace, null, 2) ?? '';
  }

  protected kickBlocked(): boolean {
    const draft = this.draft;
    return (
      draft !== null &&
      draft.mode === 'kick' &&
      draft.confirmedAimFeatures !== 2
    );
  }

  protected saveDisabled(): boolean {
    if (this.busy()) return true;
    const patch = this.changes();
    return patch === null || Object.keys(patch).length === 0;
  }

  /** A toggle flips itself on tap, so a cancel or a refusal has to flip it back. */
  protected async setEnabled(event: MatSlideToggleChange): Promise<void> {
    const alias = this.session.server();
    const enabled = event.checked;
    const ok =
      !enabled ||
      (await this.notify.confirm({
        title: 'Turn the game bot on?',
        message: 'A spectator with this name joins the selected server.',
        confirm: 'Turn on',
      }));
    if (!ok || !alias) {
      event.source.checked = !enabled;
      return;
    }
    if (!enabled) {
      if (!(await this.save(alias, { enabled: false }, true))) {
        event.source.checked = true;
      }
      return;
    }
    const patch = this.changes();
    if (patch === null) {
      event.source.checked = false;
      this.notify.error(
        new Error('Fix the game bot settings before turning it on.'),
      );
      return;
    }
    if (!(await this.save(alias, { ...patch, enabled: true }))) {
      event.source.checked = false;
    }
  }

  protected async saveSettings(): Promise<void> {
    const alias = this.session.server();
    const patch = this.changes();
    if (!alias || !patch || Object.keys(patch).length === 0) return;
    await this.save(alias, patch);
  }

  protected async load(
    alias = this.session.server(),
    append = false,
  ): Promise<void> {
    if (!alias) return;
    this.loading.set(true);
    try {
      const page = await this.api.watchEvidence(
        alias,
        append ? this.items().length : 0,
      );
      if (alias !== this.session.server()) return;
      this.items.update((items) =>
        append ? [...items, ...page.items] : page.items,
      );
      this.more.set(page.more);
    } catch (error) {
      if (alias === this.session.server()) this.notify.error(error);
    } finally {
      if (alias === this.session.server()) this.loading.set(false);
    }
  }

  private async loadBot(alias: string): Promise<void> {
    try {
      const bot = await this.api.gameBot(alias);
      if (alias !== this.session.server()) return;
      this.applyBot(bot);
    } catch (error) {
      if (alias === this.session.server()) this.notify.error(error);
    }
  }

  private applyBot(bot: GameBotResponse): void {
    this.bot.set(bot);
    this.draft = draftFrom(bot);
  }

  /** `null` means the draft cannot be stored. An empty object is unchanged. */
  private changes(): GameBotUpdate | null {
    const bot = this.bot();
    const draft = this.draft;
    if (!bot || !draft) return null;
    const name = draft.spectatorName.trim();
    if (name.length < 1 || name.length > 32) return null;
    if (draft.mode === 'kick' && draft.confirmedAimFeatures !== 2) return null;
    const body: GameBotUpdate = {};
    if (name !== bot.spectatorName) body.spectatorName = name;
    if (draft.mode !== bot.mode) body.mode = draft.mode;
    if (draft.join !== bot.join) body.join = draft.join;
    if (draft.confirmedAimFeatures !== bot.confirmedAimFeatures) {
      body.confirmedAimFeatures = draft.confirmedAimFeatures;
    }
    const numbers = [
      ['flagZ', false],
      ['kickZ', false],
      ['minFeatureN', true],
      ['minSelfLives', true],
      ['kickExtremeLives', true],
      ['kickMinSessionLives', true],
      ['cooldownMs', true],
      ['maxKicksPerHour', true],
      ['maxCardsPerHour', true],
    ] as const;
    for (const [key, integer] of numbers) {
      const value = finite(draft[key]);
      if (value === null || value < 0) return null;
      if (integer && !Number.isInteger(value)) return null;
      if (value !== bot[key]) body[key] = value;
    }
    const previous = wholeOrBlank(draft.privateClientsPrevious);
    const protocol = wholeOrBlank(draft.negotiatedProtocol);
    if (previous === undefined || protocol === undefined) return null;
    if (previous !== bot.privateClientsPrevious) {
      body.privateClientsPrevious = previous;
    }
    if (protocol !== bot.negotiatedProtocol) body.negotiatedProtocol = protocol;
    return body;
  }

  private async save(
    alias: string,
    body: GameBotUpdate,
    keepDraft = false,
  ): Promise<boolean> {
    const kept = keepDraft ? this.draft : null;
    this.busy.set(true);
    try {
      const bot = await this.api.setGameBot(alias, body);
      if (alias === this.session.server()) {
        this.applyBot(bot);
        if (kept) this.draft = kept;
        this.notify.success('Saved.');
      }
      return true;
    } catch (error) {
      if (alias === this.session.server()) this.notify.error(error);
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}

interface BotDraft {
  spectatorName: string;
  mode: WatchBotMode;
  join: WatchBotJoin;
  confirmedAimFeatures: 0 | 1 | 2;
  flagZ: number | null;
  kickZ: number | null;
  minFeatureN: number | null;
  minSelfLives: number | null;
  kickExtremeLives: number | null;
  kickMinSessionLives: number | null;
  cooldownMs: number | null;
  maxKicksPerHour: number | null;
  maxCardsPerHour: number | null;
  privateClientsPrevious: string;
  negotiatedProtocol: string;
}

function draftFrom(bot: GameBotResponse): BotDraft {
  return {
    spectatorName: bot.spectatorName,
    mode: bot.mode,
    join: bot.join,
    confirmedAimFeatures: bot.confirmedAimFeatures,
    flagZ: bot.flagZ,
    kickZ: bot.kickZ,
    minFeatureN: bot.minFeatureN,
    minSelfLives: bot.minSelfLives,
    kickExtremeLives: bot.kickExtremeLives,
    kickMinSessionLives: bot.kickMinSessionLives,
    cooldownMs: bot.cooldownMs,
    maxKicksPerHour: bot.maxKicksPerHour,
    maxCardsPerHour: bot.maxCardsPerHour,
    privateClientsPrevious:
      bot.privateClientsPrevious === null
        ? ''
        : String(bot.privateClientsPrevious),
    negotiatedProtocol:
      bot.negotiatedProtocol === null ? '' : String(bot.negotiatedProtocol),
  };
}

function finite(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Empty is null. Anything else that is not a whole number is invalid. */
function wholeOrBlank(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}
