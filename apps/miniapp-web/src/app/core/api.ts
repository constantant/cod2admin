import {
  HttpClient,
  HttpErrorResponse,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  ActionResponse,
  AddBanRequest,
  BanKind,
  BansResponse,
  ChatResponse,
  ConsoleResponse,
  MapsResponse,
  MeResponse,
  ModerationKind,
  ModerationRequest,
  StatusResponse,
  TellRequest,
  UnbanResponse,
  UpdateBanRequest,
  UpdateBanResponse,
} from '@cod2admin/miniapp-api';
import { firstValueFrom } from 'rxjs';
import { TelegramService } from './telegram';

/** Every API call carries Telegram's signed `initData` — the gateway's only gate (§8). */
export const telegramAuthInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/')) {
    return next(request);
  }
  const initData = inject(TelegramService).initData || 'dev';
  return next(
    request.clone({ setHeaders: { Authorization: `tma ${initData}` } }),
  );
};

/** An API failure, with the message the gateway wrote for people. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) {
    return error;
  }
  if (error instanceof HttpErrorResponse) {
    const body = error.error as { error?: string; message?: string } | null;
    if (body && typeof body.message === 'string') {
      return new ApiFailure(error.status, body.error ?? 'error', body.message);
    }
    if (error.status === 0) {
      return new ApiFailure(
        0,
        'offline',
        "Can't reach the bot. Check your connection and try again.",
      );
    }
    return new ApiFailure(
      error.status,
      'error',
      `The bot answered with an error (${error.status}).`,
    );
  }
  return new ApiFailure(
    0,
    'error',
    error instanceof Error ? error.message : String(error),
  );
}

const server = (alias: string) => `/api/servers/${encodeURIComponent(alias)}`;

/** Typed calls to the gateway's `/api` (apps/gateway/src/miniapp/routes.ts). */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  private async call<T>(request: ReturnType<HttpClient['get']>): Promise<T> {
    try {
      return (await firstValueFrom(request)) as T;
    } catch (error) {
      throw toApiFailure(error);
    }
  }

  me() {
    return this.call<MeResponse>(this.http.get('/api/me'));
  }

  status(alias: string) {
    return this.call<StatusResponse>(this.http.get(`${server(alias)}/status`));
  }

  moderate(
    alias: string,
    num: number,
    kind: ModerationKind,
    body: ModerationRequest,
  ) {
    return this.call<ActionResponse>(
      this.http.post(`${server(alias)}/players/${num}/${kind}`, body),
    );
  }

  maps(alias: string) {
    return this.call<MapsResponse>(this.http.get(`${server(alias)}/maps`));
  }

  changeMap(alias: string, map: string) {
    return this.call<ActionResponse>(
      this.http.post(`${server(alias)}/map`, { map }),
    );
  }

  console(alias: string, command: string) {
    return this.call<ConsoleResponse>(
      this.http.post(`${server(alias)}/console`, { command }),
    );
  }

  chat(alias: string) {
    return this.call<ChatResponse>(this.http.get(`${server(alias)}/chat`));
  }

  say(alias: string, message: string) {
    return this.call<ActionResponse>(
      this.http.post(`${server(alias)}/say`, { message }),
    );
  }

  tell(alias: string, body: TellRequest) {
    return this.call<ActionResponse>(
      this.http.post(`${server(alias)}/tell`, body),
    );
  }

  bans(kind: BanKind, query: string, includeLifted: boolean, offset: number) {
    const params: Record<string, string> = { kind, offset: String(offset) };
    if (query) {
      params['q'] = query;
    }
    if (includeLifted) {
      params['lifted'] = '1';
    }
    return this.call<BansResponse>(this.http.get('/api/bans', { params }));
  }

  updateBan(kind: BanKind, id: number, body: UpdateBanRequest) {
    return this.call<UpdateBanResponse>(
      this.http.patch(`/api/bans/${kind}/${id}`, body),
    );
  }

  unban(targets: string[]) {
    return this.call<UnbanResponse>(
      this.http.post('/api/bans/unban', { targets }),
    );
  }

  addBan(body: AddBanRequest) {
    return this.call<ActionResponse>(this.http.post('/api/bans', body));
  }
}
