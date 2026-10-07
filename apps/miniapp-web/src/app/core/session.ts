import { computed, inject, Injectable, signal } from '@angular/core';
import type { MeResponse, MiniAppRole } from '@cod2admin/miniapp-api';
import { ApiService, toApiFailure, type ApiFailure } from './api';

const ROLE_RANK: Record<MiniAppRole, number> = { moderator: 1, admin: 2, owner: 3 };
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
  readonly role = computed(() => this.me()?.role ?? null);
  readonly serverInfo = computed(() => this.me()?.servers.find((candidate) => candidate.alias === this.server()) ?? null);

  async load(): Promise<void> {
    this.failure.set(null);
    try {
      const me = await this.api.me();
      this.me.set(me);
      const stored = readStoredServer();
      this.server.set(me.servers.some((candidate) => candidate.alias === stored) ? stored! : me.defaultServer);
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

  can(minRole: MiniAppRole): boolean {
    const role = this.role();
    return role !== null && ROLE_RANK[role] >= ROLE_RANK[minRole];
  }
}
