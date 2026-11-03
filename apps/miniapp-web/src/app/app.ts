import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  type OnInit,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { MiniAppRole } from '@cod2admin/miniapp-api';
import { LiveService } from './core/live';
import { SessionService } from './core/session';
import { TelegramService } from './core/telegram';
import { t } from './shared/i18n';
import { Icon, type IconName } from './shared/icon';
import { T } from './shared/i18n';

interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  minRole: MiniAppRole;
}

const NAV: readonly NavItem[] = [
  { path: '/dashboard', label: 'Home', icon: 'home', minRole: 'moderator' },
  { path: '/players', label: 'Players', icon: 'players', minRole: 'moderator' },
  { path: '/chat', label: 'Chat', icon: 'chat', minRole: 'moderator' },
  { path: '/reports', label: 'Reports', icon: 'flag', minRole: 'moderator' },
  { path: '/more', label: 'More', icon: 'apps', minRole: 'moderator' },
];

@Component({
  selector: 'c2a-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    T,
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
  private readonly snackBar = inject(MatSnackBar);

  protected readonly loading = computed(
    () => !this.session.me() && !this.session.failure(),
  );
  protected readonly nav = computed(() =>
    this.session.me()
      ? NAV.filter((item) => this.session.can(item.minRole))
      : [],
  );
  protected readonly inTelegram = this.telegram.inTelegram;

  constructor() {
    const alerts = this.live.alerts.subscribe((message) =>
      this.snackBar.open(t(message), t('OK'), { duration: 6000 }),
    );
    inject(DestroyRef).onDestroy(() => alerts.unsubscribe());
  }

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
