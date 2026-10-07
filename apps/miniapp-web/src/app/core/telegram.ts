import { Injectable, signal } from '@angular/core';
// The official telegram-web-app.js, bundled — nothing loads from telegram.org, which is blocked
// in Russia even for people whose Telegram app works through a proxy (docs/PLAN-russia-access.md).
import WebApp from '@twa-dev/sdk';

export type Haptic = 'light' | 'success' | 'warning' | 'error';

/**
 * The Telegram side of the Mini App (docs/PLAN-miniapp.md §5): the signed `initData` every API
 * call carries, the chat's colours, and haptics. Outside Telegram (`nx serve`, §11) it does
 * nothing and `initData` is empty — the gateway then only lets requests in with
 * `MINIAPP_DEV_TELEGRAM_ID` set.
 */
@Injectable({ providedIn: 'root' })
export class TelegramService {
  /** Whether Telegram opened the app (it signed an `initData`). */
  readonly inTelegram = Boolean(WebApp.initData);
  readonly colorScheme = signal<'light' | 'dark'>(WebApp.colorScheme);

  get initData(): string {
    return WebApp.initData;
  }

  init(): void {
    if (!this.inTelegram) {
      return;
    }
    document.documentElement.classList.add('tg');
    this.applyTheme();
    WebApp.onEvent('themeChanged', () => this.applyTheme());
    WebApp.ready();
    WebApp.expand();
    if (WebApp.isVersionAtLeast('7.7')) {
      // Scrolling a long list shouldn't swipe the whole app closed.
      WebApp.disableVerticalSwipes();
    }
  }

  haptic(kind: Haptic): void {
    if (!this.inTelegram || !WebApp.isVersionAtLeast('6.1')) {
      return;
    }
    if (kind === 'light') {
      WebApp.HapticFeedback.impactOccurred('light');
    } else {
      WebApp.HapticFeedback.notificationOccurred(kind);
    }
  }

  private applyTheme(): void {
    this.colorScheme.set(WebApp.colorScheme);
    document.documentElement.style.colorScheme = WebApp.colorScheme;
    if (WebApp.isVersionAtLeast('6.1')) {
      WebApp.setHeaderColor('bg_color');
      WebApp.setBackgroundColor('bg_color');
    }
  }
}
