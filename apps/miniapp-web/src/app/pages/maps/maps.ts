import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { MapsResponse } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { LiveService } from '../../core/live';
import { SessionService } from '../../core/session';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';

/**
 * Map control (docs/PLAN-miniapp.md §6.1): the rotation, then every other installed map. A
 * custom map gets a warning first — players without it may be dropped (same rule as `/maps`).
 */
@Component({
  selector: 'c2a-maps-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, Icon],
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
  /** The live status knows a map change sooner than this page's last load. */
  protected readonly current = computed(() => this.live.status()?.mapName ?? this.maps()?.current ?? null);
  protected readonly others = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    return (this.maps()?.others ?? []).filter((map) => !needle || map.name.toLowerCase().includes(needle));
  });

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
      }
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected async change(name: string, stock: boolean): Promise<void> {
    const ok = await this.notify.confirm({
      title: `Switch to ${name}?`,
      message: stock
        ? 'The current round ends and everyone loads the new map.'
        : "It's not a standard CoD2 map: players who don't have it may be dropped unless the server offers downloads.",
      confirm: 'Switch',
      danger: !stock,
    });
    if (!ok) {
      return;
    }
    this.switching.set(name);
    try {
      this.notify.success((await this.api.changeMap(this.session.server(), name)).message);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.switching.set(null);
    }
  }
}
