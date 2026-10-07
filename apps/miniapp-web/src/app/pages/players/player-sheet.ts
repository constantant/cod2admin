import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  MAT_BOTTOM_SHEET_DATA,
  MatBottomSheet,
  MatBottomSheetRef,
} from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { ModerationKind, PlayerDto } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { SessionService } from '../../core/session';
import { DURATION_CHOICES, flagEmoji } from '../../shared/format';
import { GameName, plainName } from '../../shared/game-name';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';

export interface PlayerSheetData {
  server: string;
  player: PlayerDto;
}

type Mode = 'menu' | ModerationKind | 'tell';

/**
 * Everything you can do to one connected player (docs/PLAN-miniapp.md §6.1): details, then kick,
 * temp ban, ban or a private message — each through the same gateway code as the chat commands.
 * Opened from the player list and from a name in the chat.
 */
@Component({
  selector: 'c2a-player-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatChipsModule,
    MatFormFieldModule,
    MatInputModule,
    GameName,
    Icon,
  ],
  templateUrl: './player-sheet.html',
  styleUrl: './player-sheet.scss',
})
export class PlayerSheet {
  private readonly data = inject<PlayerSheetData>(MAT_BOTTOM_SHEET_DATA);
  private readonly ref = inject(MatBottomSheetRef<PlayerSheet>);
  private readonly api = inject(ApiService);
  private readonly notify = inject(Notify);
  protected readonly session = inject(SessionService);

  protected readonly player = this.data.player;
  protected readonly flag = flagEmoji(this.player.countryCode);
  protected readonly durations = DURATION_CHOICES;
  protected readonly mode = signal<Mode>('menu');
  protected readonly busy = signal(false);
  protected readonly reason = signal('');
  protected readonly message = signal('');
  protected readonly duration = signal(DURATION_CHOICES[0].minutes);

  protected open(mode: Mode): void {
    this.mode.set(mode);
  }

  protected async moderate(kind: ModerationKind): Promise<void> {
    const name = plainName(this.player.name) || `client ${this.player.num}`;
    if (kind === 'ban') {
      const ok = await this.notify.confirm({
        title: `Ban ${name}?`,
        message: this.player.guid
          ? 'A permanent ban, on every server. You can lift it later from Bans.'
          : 'A permanent ban of their IP (they have no GUID), on every server. You can lift it later from Bans.',
        confirm: 'Ban',
        danger: true,
      });
      if (!ok) {
        return;
      }
    }
    await this.run(() =>
      this.api.moderate(this.data.server, this.player.num, kind, {
        name: this.player.name,
        reason: this.reason().trim() || undefined,
        durationMinutes: kind === 'tempban' ? this.duration() : undefined,
      }),
    );
  }

  protected async tell(): Promise<void> {
    const message = this.message().trim();
    if (!message) {
      return;
    }
    await this.run(() =>
      this.api.tell(this.data.server, {
        num: this.player.num,
        name: this.player.name,
        message,
      }),
    );
  }

  private async run(action: () => Promise<{ message: string }>): Promise<void> {
    this.busy.set(true);
    try {
      const result = await action();
      this.notify.success(result.message);
      this.ref.dismiss(true);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}

/** Opens the sheet; resolves `true` when an action went through. */
export function openPlayerSheet(sheet: MatBottomSheet, data: PlayerSheetData) {
  return sheet.open<PlayerSheet, PlayerSheetData, boolean>(PlayerSheet, {
    data,
    autoFocus: false,
  });
}
