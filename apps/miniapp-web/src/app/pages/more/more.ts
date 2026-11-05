import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { MiniAppRole } from '@cod2admin/miniapp-api';
import { SessionService } from '../../core/session';
import { language, setLanguage, type Language } from '../../shared/i18n';
import { Icon, type IconName } from '../../shared/icon';
import { T } from '../../shared/i18n';

interface Link {
  path: string;
  label: string;
  hint: string;
  icon: IconName;
  minRole: MiniAppRole;
}

const LINKS: readonly Link[] = [
  {
    path: '/maps',
    label: 'Maps',
    hint: 'Switch map, restart, edit the rotation',
    icon: 'map',
    minRole: 'admin',
  },
  {
    path: '/bans',
    label: 'Bans',
    hint: 'Browse, edit, lift, add',
    icon: 'gavel',
    minRole: 'admin',
  },
  {
    path: '/mutes',
    label: 'Muted players',
    hint: 'A warning, then kicks for chatting',
    icon: 'mute',
    minRole: 'moderator',
  },
  {
    path: '/notes',
    label: 'Notes & watchlist',
    hint: 'Keep an eye on a player',
    icon: 'eye',
    minRole: 'moderator',
  },
  {
    path: '/servers',
    label: 'Servers',
    hint: 'Every server the bot manages',
    icon: 'dns',
    minRole: 'moderator',
  },
  {
    path: '/settings',
    label: 'Server settings',
    hint: 'What the server reports',
    icon: 'tune',
    minRole: 'admin',
  },
  {
    path: '/vpn',
    label: 'VPN rules',
    hint: 'Kick VPN players, exceptions, networks',
    icon: 'shield',
    minRole: 'admin',
  },
  {
    path: '/presets',
    label: 'Presets',
    hint: 'One-tap reasons, lengths and messages',
    icon: 'bolt',
    minRole: 'admin',
  },
  {
    path: '/admins',
    label: 'Admins',
    hint: 'Who has access, and their roles',
    icon: 'badge',
    minRole: 'admin',
  },
  {
    path: '/audit',
    label: 'Audit log',
    hint: 'Who did what',
    icon: 'history',
    minRole: 'owner',
  },
  {
    path: '/console',
    label: 'Console',
    hint: 'Raw RCON commands',
    icon: 'terminal',
    minRole: 'owner',
  },
  {
    path: '/relays',
    label: 'Telegram routes',
    hint: 'How the bot reaches Telegram',
    icon: 'route',
    minRole: 'owner',
  },
  {
    path: '/update',
    label: 'Bot update',
    hint: 'Install a new version',
    icon: 'download',
    minRole: 'owner',
  },
];

/** Everything that doesn't fit in the bottom bar, for this person's role. */
@Component({
  selector: 'c2a-more-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [T, RouterLink, Icon],
  template: `
    <div class="page">
      <nav>
        @for (link of links(); track link.path) {
          <a [routerLink]="link.path">
            <c2a-icon [name]="link.icon" />
            <span class="text">
              <span class="label">{{ link.label | t }}</span>
              <span class="muted hint">{{ link.hint | t }}</span>
            </span>
          </a>
        }
      </nav>
      <div class="language" role="group" aria-label="Language">
        <button [class.on]="language === 'ru'" (click)="setLanguage('ru')">
          Русский
        </button>
        <button [class.on]="language === 'en'" (click)="setLanguage('en')">
          English
        </button>
      </div>
      @if (session.me(); as me) {
        <p class="muted about">
          {{ me.user.username ? '@' + me.user.username : me.user.firstName }} ·
          {{ me.role | t }} {{ '· ID' | t }} {{ me.user.id }} {{ '· bot v' | t
          }}{{ me.version }}
        </p>
      }
    </div>
  `,
  styles: `
    nav {
      display: flex;
      flex-direction: column;
    }
    a {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 8px;
      color: inherit;
      text-decoration: none;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      c2a-icon {
        color: var(--mat-sys-on-surface-variant);
      }
    }
    .text {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .label {
      font: var(--mat-sys-title-small);
    }
    .hint {
      font: var(--mat-sys-body-small);
    }
    .language {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin-top: 20px;
      button {
        padding: 6px 16px;
        border-radius: 16px;
        border: 1px solid var(--mat-sys-outline-variant);
        background: none;
        color: inherit;
        font: var(--mat-sys-label-large);
        cursor: pointer;
        &.on {
          background: var(--mat-sys-secondary-container);
          color: var(--mat-sys-on-secondary-container);
        }
      }
    }
    .about {
      font: var(--mat-sys-body-small);
      text-align: center;
      margin-top: 20px;
    }
  `,
})
export class MorePage {
  protected readonly session = inject(SessionService);
  protected readonly language = language;

  protected setLanguage(next: Language): void {
    if (next !== language) {
      setLanguage(next);
    }
  }
  protected readonly links = computed(() =>
    LINKS.filter((link) => this.session.can(link.minRole)),
  );
}
