import {
  HttpClient,
  HttpErrorResponse,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  ActionResponse,
  AddAdminRequest,
  AddBanRequest,
  AddNoteRequest,
  AddServerRequest,
  AdminsResponse,
  AuditResponse,
  BanKind,
  BansResponse,
  MutesResponse,
  ChangeMapRequest,
  ChatResponse,
  ChatTemplatesResponse,
  ChatTemplatesUpdate,
  ConsoleResponse,
  CvarsResponse,
  DashboardResponse,
  LevelCommand,
  LogRequest,
  LogResponse,
  MapsResponse,
  MeResponse,
  ModerationKind,
  ModerationRequest,
  NoteDto,
  NotesResponse,
  Permission,
  PlayerHistoryResponse,
  Presets,
  RelaysResponse,
  RelayTestResponse,
  ReportsResponse,
  ResolveReportRequest,
  RotationRequest,
  ServersResponse,
  SetCvarRequest,
  StatusResponse,
  TellRequest,
  UnbanResponse,
  UpdateAdminRequest,
  UpdateBanRequest,
  UpdateBanResponse,
  UpdateNoteRequest,
  UpdateStatusResponse,
  VpnResponse,
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

  changeMap(alias: string, map: string, gametype?: string) {
    const body: ChangeMapRequest = gametype ? { map, gametype } : { map };
    return this.call<ActionResponse>(
      this.http.post(`${server(alias)}/map`, body),
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

  mute(alias: string, num: number, body: ModerationRequest) {
    return this.call<ActionResponse>(
      this.http.post(`${server(alias)}/players/${num}/mute`, body),
    );
  }

  mutes() {
    return this.call<MutesResponse>(this.http.get('/api/mutes'));
  }

  unmute(id: number) {
    return this.call<ActionResponse>(
      this.http.post(`/api/mutes/${id}/unmute`, {}),
    );
  }

  addBan(body: AddBanRequest) {
    return this.call<ActionResponse>(this.http.post('/api/bans', body));
  }

  dashboard(alias: string, hours: number) {
    return this.call<DashboardResponse>(
      this.http.get(`${server(alias)}/dashboard`, {
        params: { hours: String(hours) },
      }),
    );
  }

  levelCommand(alias: string, command: LevelCommand) {
    return this.call<ActionResponse>(
      this.http.post(`${server(alias)}/level`, { command }),
    );
  }

  saveRotation(alias: string, body: RotationRequest) {
    return this.call<ActionResponse>(
      this.http.put(`${server(alias)}/rotation`, body),
    );
  }

  cvars(alias: string) {
    return this.call<CvarsResponse>(this.http.get(`${server(alias)}/cvars`));
  }

  setCvar(alias: string, body: SetCvarRequest) {
    return this.call<ActionResponse>(
      this.http.post(`${server(alias)}/cvars`, body),
    );
  }

  reports(resolved: boolean, offset: number) {
    const params: Record<string, string> = { offset: String(offset) };
    if (resolved) {
      params['resolved'] = '1';
    }
    return this.call<ReportsResponse>(
      this.http.get('/api/reports', { params }),
    );
  }

  resolveReport(id: number, body: ResolveReportRequest) {
    return this.call<ActionResponse>(
      this.http.post(`/api/reports/${id}/resolve`, body),
    );
  }

  notes(query: string, watchOnly: boolean, offset: number) {
    const params: Record<string, string> = { offset: String(offset) };
    if (query) {
      params['q'] = query;
    }
    if (watchOnly) {
      params['watch'] = '1';
    }
    return this.call<NotesResponse>(this.http.get('/api/notes', { params }));
  }

  addNote(body: AddNoteRequest) {
    return this.call<NoteDto>(this.http.post('/api/notes', body));
  }

  updateNote(id: number, body: UpdateNoteRequest) {
    return this.call<NoteDto>(this.http.patch(`/api/notes/${id}`, body));
  }

  deleteNote(id: number) {
    return this.call<ActionResponse>(this.http.delete(`/api/notes/${id}`));
  }

  playerHistory(
    alias: string,
    player: { name: string; guid: string | null; ip: string | null },
  ) {
    const params: Record<string, string> = { name: player.name };
    if (player.guid) {
      params['guid'] = player.guid;
    }
    if (player.ip) {
      params['ip'] = player.ip;
    }
    return this.call<PlayerHistoryResponse>(
      this.http.get(`${server(alias)}/player-history`, { params }),
    );
  }

  presets() {
    return this.call<Presets>(this.http.get('/api/presets'));
  }

  savePresets(body: Presets) {
    return this.call<Presets>(this.http.put('/api/presets', body));
  }

  audit(filter: Record<string, string>, offset: number) {
    const params: Record<string, string> = { offset: String(offset) };
    for (const [key, value] of Object.entries(filter)) {
      if (value) {
        params[key] = value;
      }
    }
    return this.call<AuditResponse>(this.http.get('/api/audit', { params }));
  }

  admins() {
    return this.call<AdminsResponse>(this.http.get('/api/admins'));
  }

  addAdmin(body: AddAdminRequest) {
    return this.call<ActionResponse>(this.http.post('/api/admins', body));
  }

  setAdminPermissions(id: number, permissions: Permission[]) {
    const body: UpdateAdminRequest = { permissions };
    return this.call<ActionResponse>(
      this.http.patch(`/api/admins/${id}`, body),
    );
  }

  removeAdmin(id: number) {
    return this.call<ActionResponse>(this.http.delete(`/api/admins/${id}`));
  }

  servers() {
    return this.call<ServersResponse>(this.http.get('/api/servers'));
  }

  addServer(body: AddServerRequest) {
    return this.call<ActionResponse>(this.http.post('/api/servers', body));
  }

  removeServer(alias: string) {
    return this.call<ActionResponse>(this.http.delete(server(alias)));
  }

  setDefaultServer(alias: string) {
    return this.call<ActionResponse>(
      this.http.post(`${server(alias)}/default`, {}),
    );
  }

  serverLog(alias: string, body: LogRequest) {
    return this.call<LogResponse>(this.http.post(`${server(alias)}/log`, body));
  }

  vpn() {
    return this.call<VpnResponse>(this.http.get('/api/vpn'));
  }

  chatTemplates() {
    return this.call<ChatTemplatesResponse>(this.http.get('/api/templates'));
  }

  saveChatTemplates(texts: ChatTemplatesUpdate['texts']) {
    return this.call<ChatTemplatesResponse>(
      this.http.put('/api/templates', { texts }),
    );
  }

  setVpnKick(enabled: boolean) {
    return this.call<VpnResponse>(this.http.put('/api/vpn/kick', { enabled }));
  }

  vpnAllow(player: string) {
    return this.call<VpnResponse>(
      this.http.post('/api/vpn/exempt', { player }),
    );
  }

  vpnUnallow(player: string) {
    return this.call<VpnResponse>(
      this.http.post('/api/vpn/exempt/remove', { player }),
    );
  }

  addVpnNetwork(value: string) {
    return this.call<VpnResponse>(
      this.http.post('/api/vpn/networks', { value }),
    );
  }

  removeVpnNetwork(asn: number) {
    return this.call<VpnResponse>(this.http.delete(`/api/vpn/networks/${asn}`));
  }

  relays() {
    return this.call<RelaysResponse>(this.http.get('/api/relays'));
  }

  testRelays() {
    return this.call<RelayTestResponse>(this.http.post('/api/relays/test', {}));
  }

  addRelay(url: string) {
    return this.call<RelaysResponse>(this.http.post('/api/relays', { url }));
  }

  removeRelay(url: string) {
    return this.call<RelaysResponse>(
      this.http.post('/api/relays/remove', { url }),
    );
  }

  setRelayDirect(direct: boolean) {
    return this.call<RelaysResponse>(
      this.http.put('/api/relays/direct', { direct }),
    );
  }

  resetRelays() {
    return this.call<RelaysResponse>(this.http.post('/api/relays/reset', {}));
  }

  updateStatus() {
    return this.call<UpdateStatusResponse>(this.http.get('/api/update'));
  }

  applyUpdate(tag: string) {
    return this.call<ActionResponse>(this.http.post('/api/update', { tag }));
  }
}
