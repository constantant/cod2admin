import { effect, inject, Injectable, signal } from '@angular/core';
import type {
  ChatLineDto,
  LiveClientMessage,
  LiveServerMessage,
  StatusResponse,
} from '@cod2admin/miniapp-api';
import { Subject } from 'rxjs';
import { SessionService } from './session';
import { TelegramService } from './telegram';

const MAX_RETRY_MS = 30_000;

/**
 * The `/api/ws` feed (apps/gateway/src/miniapp/server.ts): live status and chat for the selected
 * server, without polling from every open app. Reconnects on its own; `generation` goes up on
 * every (re)connect, so a page can fetch whatever it missed while the socket was down.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly session = inject(SessionService);
  private readonly telegram = inject(TelegramService);
  private socket: WebSocket | undefined;
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private ready = false;
  /** Set when the gateway refused us (bad signature, not an admin) — retrying won't help. */
  private refused = false;

  readonly connected = signal(false);
  readonly generation = signal(0);
  readonly status = signal<StatusResponse | null>(null);
  readonly statusError = signal<string | null>(null);
  readonly chat = new Subject<ChatLineDto>();

  constructor() {
    effect(() => {
      const alias = this.session.server();
      this.status.set(null);
      this.statusError.set(null);
      if (alias && this.ready) {
        this.send({ type: 'subscribe', server: alias });
      }
    });
  }

  start(): void {
    if (this.socket) {
      return;
    }
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.send({ type: 'auth', initData: this.telegram.initData || 'dev' });
    };
    socket.onmessage = (event) =>
      this.handle(JSON.parse(String(event.data)) as LiveServerMessage);
    socket.onclose = () => {
      this.socket = undefined;
      this.ready = false;
      this.connected.set(false);
      if (this.refused) {
        return;
      }
      this.retryTimer = setTimeout(() => this.start(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    };
  }

  /** Shows a status fetched over REST (e.g. a manual refresh) until the next push. */
  showStatus(status: StatusResponse): void {
    if (status.server === this.session.server()) {
      this.status.set(status);
      this.statusError.set(null);
    }
  }

  private handle(message: LiveServerMessage): void {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.retryMs = 1000;
        this.connected.set(true);
        this.generation.update((value) => value + 1);
        if (this.session.server()) {
          this.send({ type: 'subscribe', server: this.session.server() });
        }
        break;
      case 'status':
        if (message.status.server === this.session.server()) {
          this.status.set(message.status);
          this.statusError.set(null);
        }
        break;
      case 'statusError':
        if (message.server === this.session.server()) {
          this.statusError.set(message.message);
        }
        break;
      case 'chat':
        if (message.server === this.session.server()) {
          this.chat.next(message.line);
        }
        break;
      case 'error':
        this.refused ||=
          message.error.startsWith('auth_') || message.error === 'not_admin';
        console.warn('Live feed:', message.message);
        break;
    }
  }

  private send(message: LiveClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  stop(): void {
    clearTimeout(this.retryTimer);
    this.socket?.close();
  }
}
