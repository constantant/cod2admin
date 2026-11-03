import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import { dateLocale, t } from './i18n';

export interface ChartPoint {
  at: string;
  players: number | null;
}

interface PlacedPoint extends ChartPoint {
  x: number;
  y: number | null;
}

const WIDTH = 600;
const HEIGHT = 180;

/**
 * Players over time: one thin line on a zero baseline, a gap where the server didn't answer, and a
 * crosshair with the exact value under the finger. Hand-drawn SVG, so the app stays small and loads
 * from the bot alone.
 */
@Component({
  selector: 'c2a-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="plot">
      <div class="y-axis" aria-hidden="true">
        <span>{{ top() }}</span>
        <span>{{ top() / 2 }}</span>
        <span>0</span>
      </div>
      <div
        class="area"
        role="img"
        [attr.aria-label]="label()"
        (pointermove)="hover($event)"
        (pointerdown)="hover($event)"
        (pointerleave)="active.set(null)"
      >
        <svg
          [attr.viewBox]="'0 0 ' + width + ' ' + height"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line class="grid" x1="0" [attr.x2]="width" y1="0.5" y2="0.5" />
          <line
            class="grid"
            x1="0"
            [attr.x2]="width"
            [attr.y1]="height / 2"
            [attr.y2]="height / 2"
          />
          <line
            class="base"
            x1="0"
            [attr.x2]="width"
            [attr.y1]="height - 0.5"
            [attr.y2]="height - 0.5"
          />
          <path class="line" [attr.d]="path()" />
        </svg>
        @if (active(); as point) {
          <div class="cross" [style.left.%]="(point.x / width) * 100"></div>
          @if (point.y !== null) {
            <div
              class="marker"
              [style.left.%]="(point.x / width) * 100"
              [style.top.%]="(point.y / height) * 100"
            ></div>
          }
          <div
            class="tip"
            [class.flip]="point.x > width * 0.6"
            [style.left.%]="(point.x / width) * 100"
          >
            <strong>{{ playersLabel(point.players) }}</strong>
            <span>{{ when(point.at) }}</span>
          </div>
        }
      </div>
    </div>
    <div class="x-axis" aria-hidden="true">
      <span>{{ when(since()) }}</span>
      <span>{{ when(until()) }}</span>
    </div>
  `,
  styles: `
    .plot {
      display: flex;
      gap: 6px;
      height: 180px;
    }
    .y-axis {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      text-align: right;
      min-width: 20px;
      font: var(--mat-sys-label-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .area {
      position: relative;
      flex: 1;
      min-width: 0;
      touch-action: pan-y;
      cursor: crosshair;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    line,
    .line {
      vector-effect: non-scaling-stroke;
    }
    .grid {
      stroke: var(--mat-sys-outline-variant);
      stroke-width: 1;
      opacity: 0.5;
    }
    .base {
      stroke: var(--mat-sys-outline);
      stroke-width: 1;
    }
    .line {
      fill: none;
      stroke: var(--mat-sys-primary);
      stroke-width: 2;
      stroke-linejoin: round;
      stroke-linecap: round;
    }
    .cross {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 1px;
      background: var(--mat-sys-outline);
      pointer-events: none;
    }
    .marker {
      position: absolute;
      width: 8px;
      height: 8px;
      margin: -6px 0 0 -6px;
      border-radius: 50%;
      background: var(--mat-sys-primary);
      border: 2px solid var(--mat-sys-surface-container);
      pointer-events: none;
    }
    .tip {
      position: absolute;
      top: 0;
      margin-left: 8px;
      display: flex;
      flex-direction: column;
      padding: 4px 8px;
      border-radius: 8px;
      white-space: nowrap;
      background: var(--mat-sys-inverse-surface);
      color: var(--mat-sys-inverse-on-surface);
      font: var(--mat-sys-label-small);
      pointer-events: none;
      &.flip {
        transform: translateX(-100%);
        margin-left: -8px;
      }
    }
    .x-axis {
      display: flex;
      justify-content: space-between;
      margin: 4px 0 0 26px;
      font: var(--mat-sys-label-small);
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class LineChart {
  readonly points = input.required<ChartPoint[]>();
  readonly since = input.required<string>();
  readonly until = input.required<string>();
  readonly label = input('Players over time');

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;
  protected readonly active = signal<PlacedPoint | null>(null);

  /** An even number, so the middle gridline is a whole player count. */
  protected readonly top = computed(() => {
    const highest = Math.max(
      2,
      ...this.points().map((point) => point.players ?? 0),
    );
    return highest % 2 === 0 ? highest : highest + 1;
  });

  private readonly placed = computed<PlacedPoint[]>(() => {
    const start = new Date(this.since()).getTime();
    const span = Math.max(1, new Date(this.until()).getTime() - start);
    return this.points().map((point) => ({
      ...point,
      x: ((new Date(point.at).getTime() - start) / span) * WIDTH,
      y:
        point.players === null
          ? null
          : HEIGHT - (point.players / this.top()) * HEIGHT,
    }));
  });

  /** A new segment after every gap; a lone point shows as a dot through the round line cap. */
  protected readonly path = computed(() => {
    let path = '';
    let drawing = false;
    for (const { x, y } of this.placed()) {
      if (y === null) {
        drawing = false;
        continue;
      }
      path += drawing
        ? `L${x.toFixed(1)} ${y.toFixed(1)}`
        : `M${x.toFixed(1)} ${y.toFixed(1)}h0.01`;
      drawing = true;
    }
    return path;
  });

  protected playersLabel(players: number | null): string {
    return t(players === null ? 'Offline' : `${players} players`);
  }

  protected hover(event: PointerEvent): void {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * WIDTH;
    let nearest: PlacedPoint | null = null;
    for (const point of this.placed()) {
      if (!nearest || Math.abs(point.x - x) < Math.abs(nearest.x - x)) {
        nearest = point;
      }
    }
    this.active.set(nearest);
  }

  protected when(iso: string): string {
    return new Date(iso).toLocaleString(dateLocale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
}
