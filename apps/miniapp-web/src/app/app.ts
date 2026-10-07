import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { MiniAppRole } from '@cod2admin/miniapp-api';
import { LiveService } from './core/live';
import { SessionService } from './core/session';
import { TelegramService } from './core/telegram';
import { Icon, type IconName } from './shared/icon';

interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  minRole: MiniAppRole;
}

const NAV: readonly NavItem[] = [
  { path: '/players', label: 'Players', icon: 'players', minRole: 'moderator' },
  { path: '/chat', label: 'Chat', icon: 'chat', minRole: 'moderator' },
  { path: '/maps', label: 'Maps', icon: 'map', minRole: 'admin' },
  { path: '/bans', label: 'Bans', icon: 'gavel', minRole: 'admin' },
  { path: '/console', label: 'Console', icon: 'terminal', minRole: 'owner' },
];

@Component({
  selector: 'c2a-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatButtonModule,
    MatSelectModule,
    MatProgressBarModule,
    Icon,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  protected readonly session = inject(SessionService);
  protected readonly live = inject(LiveService);
  private readonly telegram = inject(TelegramService);

  protected readonly loading = computed(
    () => !this.session.me() && !this.session.failure(),
  );
  protected readonly nav = computed(() =>
    this.session.me()
      ? NAV.filter((item) => this.session.can(item.minRole))
      : [],
  );
  protected readonly inTelegram = this.telegram.inTelegram;

  async ngOnInit(): Promise<void> {
    this.telegram.init();
    await this.session.load();
    if (this.session.me()) {
      this.live.start();
    }
  }

  protected retry(): void {
    void this.ngOnInit();
  }
}
