import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { prettyMapName } from './map-art';
import { MapThumb } from './map-thumb';

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
  imports: [MapThumb],
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

  protected readonly pretty = computed(() => prettyMapName(this.name()));
  protected readonly modeLabel = computed(() => {
    const mode = this.mode();
    return mode ? (MODE_LABELS[mode.toLowerCase()] ?? mode.toUpperCase()) : '';
  });
}
