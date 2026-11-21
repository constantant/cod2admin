import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { T } from './i18n';
import { prettyMapName } from './map-art';
import { MapThumb } from './map-thumb';

/** How long past its limit a map still shows "ending" before the estimate is dropped. */
const OVERTIME_MS = 10 * 60_000;

/** Short names for the stock CoD2 modes; a mod's own modes show as their name in capitals. */
const MODE_LABELS: Record<string, string> = {
  ctf: 'CTF',
  tdm: 'TDM',
  dm: 'DM',
  sd: 'S&D',
  hq: 'HQ',
};

/**
 * The current map across the top of a card: its picture (or a generated tile) with the map's name
 * and mode over it. It runs to the card's edges, so put it first inside a padded `.card`.
 */
@Component({
  selector: 'c2a-map-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MapThumb, T],
  template: `
    <div class="hero">
      <c2a-map-thumb
        class="picture"
        [name]="name()"
        [showName]="false"
        [fill]="true"
      />
      <div class="label">
        <div class="text">
          <div class="title">{{ pretty() }}</div>
          <div class="raw">{{ name() }}</div>
        </div>
        @if (remaining(); as left) {
          <span class="mode left">{{ left | t }}</span>
        }
        @if (modeLabel(); as mode) {
          <span class="mode">{{ mode }}</span>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      margin: -14px -16px 12px;
    }
    .hero {
      position: relative;
      aspect-ratio: 21 / 9;
      overflow: hidden;
      border-radius: 16px 16px 0 0;
      color: #fff;
    }
    .picture {
      position: absolute;
      inset: 0;
    }
    .label {
      position: absolute;
      inset: auto 0 0;
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 28px 16px 10px;
      background: linear-gradient(transparent, rgb(0 0 0 / 70%));
    }
    .text {
      flex: 1;
      min-width: 0;
      text-shadow: 0 1px 3px rgb(0 0 0 / 60%);
    }
    .title {
      font: var(--mat-sys-title-large);
    }
    .raw {
      font: var(--mat-sys-label-small);
      opacity: 0.8;
      overflow-wrap: anywhere;
    }
    .left {
      font-variant-numeric: tabular-nums;
    }
    .mode {
      flex: none;
      padding: 2px 10px;
      border-radius: 8px;
      font: var(--mat-sys-label-large);
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
    }
  `,
})
export class MapBanner {
  readonly name = input.required<string>();
  readonly mode = input<string | null | undefined>(null);
  /** The map's time limit and when it was seen to start; together they make the countdown. */
  readonly timeLimitMinutes = input<number | undefined>(undefined);
  readonly startedAt = input<string | undefined>(undefined);

  private readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /**
   * An estimate (the game doesn't report its clock): empty when there is no limit or start, and
   * again once the map is well past its limit, which means it was restarted without us noticing.
   */
  protected readonly remaining = computed(() => {
    const limit = this.timeLimitMinutes();
    const startedAt = this.startedAt();
    if (!limit || !startedAt) {
      return '';
    }
    const left = Date.parse(startedAt) + limit * 60_000 - this.now();
    if (Number.isNaN(left) || left < -OVERTIME_MS) {
      return '';
    }
    return left <= 0 ? 'ending' : `~${Math.ceil(left / 60_000)} min left`;
  });

  protected readonly pretty = computed(() => prettyMapName(this.name()));
  protected readonly modeLabel = computed(() => {
    const mode = this.mode();
    return mode ? (MODE_LABELS[mode.toLowerCase()] ?? mode.toUpperCase()) : '';
  });
}
