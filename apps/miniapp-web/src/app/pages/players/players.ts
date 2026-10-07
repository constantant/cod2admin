import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { PlayerDto } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { LiveService } from '../../core/live';
import { SessionService } from '../../core/session';
import { flagEmoji, formatAgo } from '../../shared/format';
import { GameName, plainName } from '../../shared/game-name';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';
import { openPlayerSheet } from './player-sheet';

type SortKey = 'score' | 'name' | 'ping' | 'num';

/** Live server status and the player list (docs/PLAN-miniapp.md §6.1) — tap a player to act. */
@Component({
  selector: 'c2a-players-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatButtonModule, MatButtonToggleModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, GameName, Icon],
  templateUrl: './players.html',
  styleUrl: './players.scss',
})
export class PlayersPage {
  private readonly api = inject(ApiService);
  private readonly sheet = inject(MatBottomSheet);
  private readonly notify = inject(Notify);
  protected readonly live = inject(LiveService);
  protected readonly session = inject(SessionService);

  protected readonly filter = signal('');
  protected readonly sort = signal<SortKey>('score');
  protected readonly refreshing = signal(false);
  /** Re-renders "updated … ago" without a new status. */
  private readonly tick = signal(Date.now());

  protected readonly status = this.live.status;
  protected readonly players = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    const players = (this.status()?.players ?? []).filter(
      (player) => !needle || plainName(player.name).toLowerCase().includes(needle) || player.ip?.includes(needle),
    );
    const key = this.sort();
    return [...players].sort((a, b) => {
      if (key === 'name') {
        return plainName(a.name).localeCompare(plainName(b.name));
      }
      if (key === 'ping') {
        return a.ping - b.ping;
      }
      if (key === 'num') {
        return a.num - b.num;
      }
      return b.score - a.score;
    });
  });
  protected readonly flagged = computed(() => (this.status()?.players ?? []).filter((player) => player.vpn).length);
  protected readonly updated = computed(() => {
    this.tick();
    const status = this.status();
    return status ? formatAgo(status.fetchedAt) : '';
  });

  constructor() {
    const timer = setInterval(() => this.tick.set(Date.now()), 15_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    // Until the live feed delivers, fetch once so the page isn't empty.
    effect(() => {
      if (this.session.server() && !this.live.status()) {
        untracked(() => void this.refresh(true));
      }
    });
  }

  /** The location already says `LAN` for local addresses, so they get no flag. */
  protected flag(player: PlayerDto): string {
    return flagEmoji(player.countryCode);
  }

  protected async refresh(quiet = false): Promise<void> {
    if (this.refreshing()) {
      return;
    }
    this.refreshing.set(true);
    try {
      this.live.showStatus(await this.api.status(this.session.server()));
    } catch (error) {
      if (!quiet) {
        this.notify.error(error);
      } else {
        this.live.statusError.set((error as Error).message);
      }
    } finally {
      this.refreshing.set(false);
    }
  }

  protected openPlayer(player: PlayerDto): void {
    openPlayerSheet(this.sheet, { server: this.session.server(), player })
      .afterDismissed()
      .subscribe((done) => {
        if (done) {
          void this.refresh(true);
        }
      });
  }
}
