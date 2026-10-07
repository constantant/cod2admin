import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { MapsResponse } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { LiveService } from '../../core/live';
import { SessionService } from '../../core/session';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';

/** Short names for the stock CoD2 modes; a mod's own modes show as their name in capitals. */
const MODE_LABELS: Record<string, string> = {
  ctf: 'CTF',
  tdm: 'TDM',
  dm: 'DM',
  sd: 'S&D',
  hq: 'HQ',
};

export function modeLabel(gametype: string | null | undefined): string {
  return gametype
    ? (MODE_LABELS[gametype.toLowerCase()] ?? gametype.toUpperCase())
    : '';
}

/**
 * Map control (docs/PLAN-miniapp.md §6.1): pick a game mode (CTF first, when the server has it),
 * then a map to load in it — or one of the rotation's own map + mode pairs. A custom map gets a
 * warning first — players without it may be dropped (same rule as `/maps`).
 */
@Component({
  selector: 'c2a-maps-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatChipsModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    Icon,
  ],
  templateUrl: './maps.html',
  styleUrl: './maps.scss',
})
export class MapsPage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  private readonly live = inject(LiveService);
  protected readonly session = inject(SessionService);

  protected readonly maps = signal<MapsResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly switching = signal<string | null>(null);
  protected readonly filter = signal('');
  /** The mode the map buttons load in. */
  protected readonly mode = signal<string | null>(null);
  protected readonly label = modeLabel;
  /** The live status knows a map change sooner than this page's last load. */
  protected readonly current = computed(
    () => this.live.status()?.mapName ?? this.maps()?.current ?? null,
  );
  protected readonly visibleMaps = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    return (this.maps()?.maps ?? []).filter(
      (map) => !needle || map.name.toLowerCase().includes(needle),
    );
  });

  protected readonly hasCustom = computed(() =>
    (this.maps()?.maps ?? []).some((map) => !map.stock),
  );

  protected readonly emptyText = computed(() =>
    this.filter()
      ? `No map matches "${this.filter()}".`
      : 'The server lists no maps.',
  );

  constructor() {
    effect(() => {
      const alias = this.session.server();
      untracked(() => void this.load(alias));
    });
  }

  protected async load(alias = this.session.server()): Promise<void> {
    this.loading.set(true);
    this.maps.set(null);
    try {
      const maps = await this.api.maps(alias);
      if (alias === this.session.server()) {
        this.maps.set(maps);
        this.mode.set(maps.defaultGametype);
      }
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  /** Whether this button is what's playing now (same map, and same mode when it has one). */
  protected isCurrent(map: string, gametype: string | null): boolean {
    const maps = this.maps();
    return (
      map === this.current() &&
      (!gametype || gametype === maps?.currentGametype)
    );
  }

  /** `gametype` null: load in whatever mode the server is in. */
  protected async change(
    name: string,
    stock: boolean,
    gametype: string | null,
  ): Promise<void> {
    const from = this.maps()?.currentGametype ?? null;
    const lines = [
      stock
        ? 'The current round ends and everyone loads the new map.'
        : "It's not a standard CoD2 map: players who don't have it may be dropped unless the server offers downloads.",
    ];
    if (gametype && from && gametype.toLowerCase() !== from.toLowerCase()) {
      lines.push(
        `The mode changes from ${modeLabel(from)} to ${modeLabel(gametype)}.`,
      );
    }
    const ok = await this.notify.confirm({
      title: `Switch to ${name}${gametype ? ` (${modeLabel(gametype)})` : ''}?`,
      message: lines.join(' '),
      confirm: 'Switch',
      danger: !stock,
    });
    if (!ok) {
      return;
    }
    this.switching.set(name);
    try {
      const result = await this.api.changeMap(
        this.session.server(),
        name,
        gametype ?? undefined,
      );
      this.notify.success(result.message);
      this.maps.update((maps) =>
        maps
          ? {
              ...maps,
              current: name,
              currentGametype: gametype ?? maps.currentGametype,
            }
          : maps,
      );
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.switching.set(null);
    }
  }
}
