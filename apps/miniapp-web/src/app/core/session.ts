import { computed, inject, Injectable, signal } from '@angular/core';
import type { MeResponse, Permission } from '@cod2admin/miniapp-api';
import { ApiService, toApiFailure, type ApiFailure } from './api';

const SERVER_KEY = 'cod2admin.server';

function readStoredServer(): string | null {
  try {
    return localStorage.getItem(SERVER_KEY);
  } catch {
    return null;
  }
}

function storeServer(alias: string): void {
  try {
    localStorage.setItem(SERVER_KEY, alias);
  } catch {
    // Storage can be off in a WebView — the choice just isn't remembered then.
  }
}

/** Who's using the app, what they may do, and which server they're looking at. */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly api = inject(ApiService);
  private markLoaded: () => void = () => undefined;
  /** Settles once the first `load()` finished, either way — route guards wait for it. */
  readonly loaded = new Promise<void>((resolve) => (this.markLoaded = resolve));

  readonly me = signal<MeResponse | null>(null);
  readonly failure = signal<ApiFailure | null>(null);
  readonly server = signal<string>('');
  readonly serverInfo = computed(
    () =>
      this.me()?.servers.find(
        (candidate) => candidate.alias === this.server(),
      ) ?? null,
  );

  async load(): Promise<void> {
    this.failure.set(null);
    try {
      const me = await this.api.me();
      this.me.set(me);
      const stored = readStoredServer();
      this.server.set(
        me.servers.some((candidate) => candidate.alias === stored)
          ? stored!
          : me.defaultServer,
      );
    } catch (error) {
      this.failure.set(toApiFailure(error));
    } finally {
      this.markLoaded();
    }
  }

  selectServer(alias: string): void {
    this.server.set(alias);
    storeServer(alias);
  }

  /**
   * No id: any staff member (a loaded session). Otherwise, whether `me.permissions`
   * includes it — the owner already has every id, so this does not look at `isOwner`.
   */
  can(permission?: Permission): boolean {
    const me = this.me();
    return (
      me !== null &&
      (permission === undefined || me.permissions.includes(permission))
    );
  }
}
