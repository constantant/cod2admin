import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import type { BanDto, BanKind } from '@cod2admin/miniapp-api';
import { ApiService } from '../../core/api';
import { SessionService } from '../../core/session';
import { flagEmoji, formatAgo, formatSpan } from '../../shared/format';
import { GameName } from '../../shared/game-name';
import { Icon } from '../../shared/icon';
import { Notify } from '../../shared/notify';
import { AddBanDialog, EditBanDialog } from './ban-dialogs';

const SEARCH_DELAY_MS = 300;

/** What to unban a ban by: `/unban` lifts every ban on that GUID or IP. */
function unbanTarget(ban: BanDto): string {
  return (ban.kind === 'ip' ? ban.ip : ban.guid) ?? '';
}

/**
 * Ban management (docs/PLAN-miniapp.md §6.3): browse and search GUID and IP bans, edit reason or
 * expiry, lift one or many, add one for someone offline. Bans are global, so this page doesn't
 * depend on the selected server (except as where a new ban is recorded as issued).
 */
@Component({
  selector: 'c2a-bans-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatMenuModule,
    MatProgressBarModule,
    MatSlideToggleModule,
    GameName,
    Icon,
  ],
  templateUrl: './bans.html',
  styleUrl: './bans.scss',
})
export class BansPage {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly session = inject(SessionService);

  protected readonly kind = signal<BanKind>('ip');
  protected readonly query = signal('');
  protected readonly includeLifted = signal(false);
  protected readonly items = signal<BanDto[]>([]);
  protected readonly more = signal(false);
  protected readonly loading = signal(false);
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly selectedCount = computed(() => this.selected().size);
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private requestId = 0;

  constructor() {
    effect(() => {
      this.kind();
      this.includeLifted();
      untracked(() => void this.load(false));
    });
  }

  protected onSearch(value: string): void {
    this.query.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.load(false), SEARCH_DELAY_MS);
  }

  protected async load(append: boolean): Promise<void> {
    const id = ++this.requestId;
    this.loading.set(true);
    if (!append) {
      this.selected.set(new Set());
    }
    try {
      const page = await this.api.bans(this.kind(), this.query().trim(), this.includeLifted(), append ? this.items().length : 0);
      if (id !== this.requestId) {
        return; // a newer search started meanwhile
      }
      this.items.set(append ? [...this.items(), ...page.items] : page.items);
      this.more.set(page.more);
    } catch (error) {
      this.notify.error(error);
    } finally {
      if (id === this.requestId) {
        this.loading.set(false);
      }
    }
  }

  protected flag(ban: BanDto): string {
    return flagEmoji(ban.countryCode);
  }

  protected expiry(ban: BanDto): string {
    if (ban.liftedAt) {
      return `lifted ${formatAgo(ban.liftedAt)}`;
    }
    return ban.expiresAt ? `${formatSpan(new Date(ban.expiresAt).getTime() - Date.now())} left` : 'permanent';
  }

  protected ago(iso: string): string {
    return formatAgo(iso);
  }

  protected key(ban: BanDto): string {
    return `${ban.kind}:${ban.id}`;
  }

  protected toggle(ban: BanDto): void {
    this.selected.update((selected) => {
      const next = new Set(selected);
      if (!next.delete(this.key(ban))) {
        next.add(this.key(ban));
      }
      return next;
    });
  }

  protected edit(ban: BanDto): void {
    this.dialog
      .open(EditBanDialog, { data: ban, maxWidth: '480px', width: '100%', autoFocus: false })
      .afterClosed()
      .subscribe((updated?: BanDto) => {
        if (updated) {
          this.items.update((items) => items.map((item) => (this.key(item) === this.key(updated) ? updated : item)));
        }
      });
  }

  protected add(): void {
    this.dialog
      .open(AddBanDialog, { data: this.session.server(), maxWidth: '480px', width: '100%', autoFocus: false })
      .afterClosed()
      .subscribe((added?: boolean) => {
        if (added) {
          void this.load(false);
        }
      });
  }

  protected async unban(bans: BanDto[]): Promise<void> {
    const targets = [...new Set(bans.map(unbanTarget).filter(Boolean))];
    if (targets.length === 0) {
      return;
    }
    const ok = await this.notify.confirm({
      title: targets.length === 1 ? `Unban ${targets[0]}?` : `Unban ${targets.length} players?`,
      message: 'Lifts every ban on these GUIDs/IPs, on all servers.',
      confirm: 'Unban',
    });
    if (!ok) {
      return;
    }
    try {
      const { results } = await this.api.unban(targets);
      const unanswered = [...new Set(results.flatMap((result) => result.unanswered))];
      if (unanswered.length > 0) {
        this.notify.info(`Unbanned. ${unanswered.join(', ')} didn't answer, so its ban.txt may still block them — try again later.`);
      } else {
        this.notify.success(targets.length === 1 ? 'Unbanned.' : `Unbanned ${targets.length}.`);
      }
      await this.load(false);
    } catch (error) {
      this.notify.error(error);
    }
  }

  protected clearSelection(): void {
    this.selected.set(new Set());
  }

  protected unbanSelected(): void {
    const selected = this.selected();
    void this.unban(this.items().filter((ban) => selected.has(this.key(ban))));
  }
}
