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
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type {
  ModerationKind,
  NoteKind,
  PlayerDto,
  PlayerHistoryResponse,
} from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { PresetsService } from '../../core/presets';
import { SessionService } from '../../core/session';
import { flagEmoji, formatAgo, formatMinutes } from '../../shared/format';
import { GameName, plainName } from '../../shared/game-name';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';
import { t, T } from '../../shared/i18n';

export interface PlayerSheetData {
  server: string;
  player: PlayerDto;
}

type Mode = 'menu' | ModerationKind | 'mute' | 'tell' | 'history';

/**
 * Everything you can do to one connected player (docs/PLAN-miniapp.md §6.1): details, then kick,
 * temp ban, ban or a private message — each through the same gateway code as the chat commands.
 * Opened from the player list and from a name in the chat.
 */
@Component({
  selector: 'c2a-player-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
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
  private readonly presetsService = inject(PresetsService);
  protected readonly session = inject(SessionService);

  protected readonly player = this.data.player;
  protected readonly flag = flagEmoji(this.player.countryCode);
  protected readonly presets = this.presetsService.presets;
  protected readonly durationLabel = (minutes: number) =>
    t(formatMinutes(minutes));
  protected readonly ago = formatAgo;
  protected readonly history = signal<PlayerHistoryResponse | null>(null);
  protected readonly noteText = signal('');
  protected readonly noteWatch = signal(false);
  protected readonly mode = signal<Mode>('menu');
  protected readonly busy = signal(false);
  protected readonly reason = signal('');
  protected readonly message = signal('');
  protected readonly duration = signal(30);

  constructor() {
    void this.presetsService.load().then(() => {
      const [first] = this.presets().durations;
      if (first) {
        this.duration.set(first);
      }
    });
  }

  protected open(mode: Mode): void {
    this.mode.set(mode);
    if (mode === 'history' && !this.history()) {
      void this.loadHistory();
    }
  }

  private async loadHistory(): Promise<void> {
    try {
      this.history.set(
        await this.api.playerHistory(this.data.server, this.player),
      );
    } catch (error) {
      this.notify.error(error);
    }
  }

  /** On the most certain identity they have: most players' GUID is 0, and anyone can take a name. */
  protected noteTarget(): { kind: NoteKind; value: string; label: string } {
    const { guid, ip, name } = this.player;
    if (guid) {
      return { kind: 'guid', value: guid, label: `GUID ${guid}` };
    }
    if (ip) {
      return { kind: 'ip', value: ip, label: `IP ${ip}` };
    }
    return { kind: 'name', value: name, label: t('their name') };
  }

  protected async addNote(): Promise<void> {
    const { kind, value } = this.noteTarget();
    const note = this.noteText().trim();
    if (!note) {
      return;
    }
    this.busy.set(true);
    try {
      await this.api.addNote({ kind, value, note, watch: this.noteWatch() });
      this.noteText.set('');
      this.noteWatch.set(false);
      this.notify.success('Note added.');
      await this.loadHistory();
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.busy.set(false);
    }
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

  protected async mute(): Promise<void> {
    await this.run(() =>
      this.api.mute(this.data.server, this.player.num, {
        name: this.player.name,
        reason: this.reason().trim() || undefined,
        durationMinutes: this.duration() || undefined,
      }),
    );
  }

  protected async markKnown(): Promise<void> {
    await this.run(() =>
      this.api.markKnown(this.data.server, this.player.num, this.player.name),
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
