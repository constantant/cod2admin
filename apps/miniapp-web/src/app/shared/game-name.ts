import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export interface NameSegment {
  text: string;
  /** The `^N` colour digit in effect, or null for the default text colour. */
  color: string | null;
}

/**
 * Splits a CoD2 name into its `^N`-coloured runs, as the game draws them. Drops the doubled
 * `^^11` form some players use, as the bot's `displayName` does (apps/gateway players.ts). `^0`
 * (black) and `^7` (white) use the normal text colour, so they stay readable on either theme.
 */
export function parseColoredName(raw: string): NameSegment[] {
  const segments: NameSegment[] = [];
  let color: string | null = null;
  for (const part of raw.replace(/\^\^(\d)\1/g, '').split(/(\^\d)/)) {
    if (/^\^\d$/.test(part)) {
      const digit = part[1];
      color = digit === '0' || digit === '7' ? null : digit;
    } else if (part) {
      const last = segments.at(-1);
      if (last && last.color === color) {
        last.text += part;
      } else {
        segments.push({ text: part, color });
      }
    }
  }
  return segments;
}

/** The name without colour codes — for search, sorting and confirmations. */
export function plainName(raw: string): string {
  return parseColoredName(raw)
    .map((segment) => segment.text)
    .join('')
    .trim();
}

/** A player name in its in-game colours. */
@Component({
  selector: 'c2a-game-name',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@for (segment of segments(); track $index) {<span [class]="segment.color ? 'c' + segment.color : null">{{ segment.text }}</span>}@empty {<span class="none">(no name yet)</span>}`,
  styles: `
    :host {
      overflow-wrap: anywhere;
    }
    .c1 { color: #e53935; }
    .c2 { color: #43a047; }
    .c3 { color: #f9a825; }
    .c4 { color: #1e88e5; }
    .c5 { color: #00acc1; }
    .c6 { color: #d81b60; }
    .c8 { color: #fb8c00; }
    .c9 { color: #8e8e8e; }
    .none { color: var(--mat-sys-on-surface-variant); font-style: italic; }
  `,
})
export class GameName {
  readonly name = input.required<string>();
  protected readonly segments = computed(() => parseColoredName(this.name()));
}
