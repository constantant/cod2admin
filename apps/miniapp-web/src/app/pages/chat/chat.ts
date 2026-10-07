import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import type { ChatLineDto } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { LiveService } from '../../core/live';
import { SessionService } from '../../core/session';
import { TelegramService } from '../../core/telegram';
import { formatClock } from '../../shared/format';
import { GameName, plainName } from '../../shared/game-name';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';
import { openPlayerSheet } from '../players/player-sheet';

const MAX_LINES = 300;
/** The recipient picker's "Everyone" — not `null`, which mat-select shows as no choice at all. */
const EVERYONE = -1;
/** Closer than this to the bottom counts as "reading the newest lines" — new ones scroll into view. */
const STICK_TO_BOTTOM_PX = 80;

/**
 * The in-game chat (docs/PLAN-miniapp.md §6.2): what's in the log already, then live lines over
 * the WebSocket. Admins can write to everyone (`say`) or to one player (`tell`).
 */
@Component({
  selector: 'c2a-chat-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    GameName,
    Icon,
  ],
  templateUrl: './chat.html',
  styleUrl: './chat.scss',
})
export class ChatPage {
  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  private readonly sheet = inject(MatBottomSheet);
  private readonly notify = inject(Notify);
  private readonly telegram = inject(TelegramService);
  private readonly injector = inject(Injector);
  protected readonly session = inject(SessionService);

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  protected readonly lines = signal<ChatLineDto[]>([]);
  protected readonly available = signal(true);
  protected readonly loading = signal(false);
  protected readonly sending = signal(false);
  protected readonly draft = signal('');
  /** `EVERYONE`, else the slot to whisper to. */
  protected readonly to = signal<number>(EVERYONE);
  protected readonly everyone = EVERYONE;
  protected readonly players = computed(
    () => this.live.status()?.players ?? [],
  );

  constructor() {
    // Reload on server switch and after every reconnect, to fill what the socket missed.
    effect(() => {
      const alias = this.session.server();
      this.live.generation();
      untracked(() => void this.load(alias));
    });
    const subscription = this.live.chat.subscribe((line) =>
      this.append([line]),
    );
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }

  protected clock(line: ChatLineDto): string {
    return line.at ? formatClock(line.at) : '';
  }

  protected plain(name: string): string {
    return plainName(name);
  }

  private async load(alias: string): Promise<void> {
    this.loading.set(true);
    try {
      const chat = await this.api.chat(alias);
      if (alias !== this.session.server()) {
        return;
      }
      this.available.set(chat.available);
      this.lines.set([]);
      this.append(chat.lines, true);
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  /** Adds lines by id — a live line may also come back in a reload. */
  private append(incoming: ChatLineDto[], forceScroll = false): void {
    const element = this.scroller()?.nativeElement;
    const atBottom =
      !element ||
      element.scrollHeight - element.scrollTop - element.clientHeight <
        STICK_TO_BOTTOM_PX;
    this.lines.update((lines) => {
      const byId = new Map(lines.map((line) => [line.id, line]));
      for (const line of incoming) {
        byId.set(line.id, line);
      }
      return [...byId.values()].sort((a, b) => a.id - b.id).slice(-MAX_LINES);
    });
    if (forceScroll || atBottom) {
      afterNextRender(() => this.scrollToBottom(), { injector: this.injector });
    }
  }

  private scrollToBottom(): void {
    const element = this.scroller()?.nativeElement;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }

  protected openPlayer(line: ChatLineDto): void {
    // `status` and the log don't agree on colour codes, so compare names as players read them.
    const player = this.players().find(
      (candidate) =>
        candidate.num === line.num &&
        plainName(candidate.name) === plainName(line.name),
    );
    if (line.source !== 'game' || !player) {
      return;
    }
    this.telegram.haptic('light');
    openPlayerSheet(this.sheet, { server: this.session.server(), player });
  }

  protected async send(): Promise<void> {
    const message = this.draft().trim();
    if (!message || this.sending()) {
      return;
    }
    this.sending.set(true);
    try {
      const to = this.to();
      const player =
        to === EVERYONE
          ? undefined
          : this.players().find((candidate) => candidate.num === to);
      if (to !== EVERYONE && !player) {
        this.notify.info('That player has left — pick someone else.');
        this.to.set(EVERYONE);
        return;
      }
      if (player) {
        await this.api.tell(this.session.server(), {
          num: player.num,
          name: player.name,
          message,
        });
      } else {
        await this.api.say(this.session.server(), message);
      }
      this.telegram.haptic('light');
      this.draft.set('');
    } catch (error) {
      this.notify.error(error);
    } finally {
      this.sending.set(false);
    }
  }
}
