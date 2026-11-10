import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import { mapGradient, mapImageUrl, prettyMapName } from './map-art';

/**
 * A map's picture: its loading screen when the app has one (`public/maps/<name>.webp`), else a
 * generated tile with the readable name. The size comes from the parent (it fills its width, 4:3);
 * anything projected into it (a mode badge, say) sits on top.
 */
@Component({
  selector: 'c2a-map-thumb',
  host: { '[class.fill]': 'fill()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="art" [style.background]="gradient()">
      @if (showName()) {
        <span class="name">{{ pretty() }}</span>
      }
      @if (!failed()) {
        <img
          [src]="url()"
          alt=""
          loading="lazy"
          (error)="failedFor.set(name())"
        />
      }
      <ng-content />
    </span>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
    }
    :host(.fill),
    :host(.fill) .art {
      height: 100%;
      aspect-ratio: auto;
    }
    .art {
      position: relative;
      display: flex;
      align-items: flex-end;
      aspect-ratio: 4 / 3;
      width: 100%;
      overflow: hidden;
      border-radius: inherit;
    }
    img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .name {
      padding: 6px 8px;
      font: var(--mat-sys-title-medium);
      color: #fff;
      text-shadow: 0 1px 3px rgb(0 0 0 / 60%);
    }
  `,
})
export class MapThumb {
  readonly name = input.required<string>();
  /** Off for small thumbnails, where the generated tile's name wouldn't fit. */
  readonly showName = input(true);
  /** Fill the parent's height instead of keeping 4:3 (for a banner). */
  readonly fill = input(false);

  protected readonly failedFor = signal<string | null>(null);
  protected readonly failed = computed(() => this.failedFor() === this.name());
  protected readonly gradient = computed(() => mapGradient(this.name()));
  protected readonly pretty = computed(() => prettyMapName(this.name()));
  protected readonly url = computed(() => mapImageUrl(this.name()));
}
