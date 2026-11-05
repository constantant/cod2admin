import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import type { MuteDto } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { formatAgo, formatSpan } from '../../shared/format';
import { GameName } from '../../shared/game-name';
import { T } from '../../shared/i18n';
import { Notify } from '../../shared/notify';

/** Who's muted, on any server, and lifting a mute. Muting itself starts from a player's sheet. */
@Component({
  selector: 'c2a-mutes-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatProgressBarModule, GameName, T],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <div class="page">
      <h2>{{ 'Muted players' | t }}</h2>
      <p class="muted small">
        {{ "The game can't block chat, so their messages still appear. The first gets them a private warning, each one after that a kick. Applies on every server whose chat the bot can read." | t }}
      </p>
      <ul class="mutes">
        @for (mute of items(); track mute.id) {
          <li>
            <div class="main">
              <div class="who">
                <c2a-game-name [name]="mute.name" />
                @if (mute.ip) {
                  <span class="mono small">{{ mute.ip }}</span>
                }
              </div>
              @if (mute.reason) {
                <div>{{ mute.reason }}</div>
              }
              <div class="muted small">
                {{ expiry(mute) | t }} · {{ 'by' | t }} {{ mute.mutedBy }} ·
                {{ ago(mute.mutedAt) }} {{ '· on' | t }} {{ mute.server }}
              </div>
            </div>
            <button
              mat-stroked-button
              [disabled]="busy()"
              (click)="unmute(mute)"
            >
              {{ 'Unmute' | t }}
            </button>
          </li>
        } @empty {
          @if (!loading()) {
            <li class="muted">{{ 'No muted players.' | t }}</li>
          }
        }
      </ul>
    </div>
  `,
  styles: `
    h2 {
      margin: 0 0 8px;
      font: var(--mat-sys-title-medium);
    }
    .small {
      font: var(--mat-sys-body-small);
    }
    .mutes {
      list-style: none;
      margin: 8px 0 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .main {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .who {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 10px;
      font: var(--mat-sys-title-small);
    }
    button {
      flex: none;
    }
  `,
})
export class MutesPage {
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);

  protected readonly items = signal<MuteDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly ago = formatAgo;

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.items.set((await this.api.mutes()).items);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected expiry(mute: MuteDto): string {
    return mute.expiresAt
      ? `${formatSpan(new Date(mute.expiresAt).getTime() - Date.now())} left`
      : 'permanent';
  }

  protected async unmute(mute: MuteDto): Promise<void> {
    this.busy.set(true);
    try {
      this.notify.success((await this.api.unmute(mute.id)).message);
      await this.load();
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
