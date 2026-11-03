import type { AuditLogEntry, PlayerNote, Report } from '@cod2admin/admin-store';
import { stripColorCodes } from '@cod2admin/rcon-client';
import { matchPlayersByName } from '@cod2admin/report-pipeline';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { GatewayDeps } from '../lib/deps.js';
import { formatTelegramUser } from '../lib/telegram-user.js';
import { isIpv4 } from '../lib/unban-actions.js';
import { ApiProblem } from './api-problem.js';
import type {
  ActionResponse,
  AddNoteRequest,
  AuditEntryDto,
  DashboardResponse,
  NoteDto,
  NoteKind,
  NotesResponse,
  PlayerDto,
  PlayerHistoryResponse,
  ReportDto,
  ReportsResponse,
  ResolveReportRequest,
  UpdateNoteRequest,
} from './api-types.js';
import { actorLabel, hasRole, type MiniAppActor } from './auth.js';
import { summarizeSnapshots } from './dashboard.js';
import { toGuidBanDto, toIpBanDto, type AdminNames } from './dto.js';
import { adminNames, serverParam } from './routes.js';
import { noteNameKey, type MiniAppState } from './state.js';

const PAGE_SIZE = 50;
const HISTORY_LIMIT = 20;
const MAX_NOTE = 500;
const DASHBOARD_HOURS = [24, 168, 720];

function offsetParam(value: string | undefined): number {
  return Math.max(0, Number.parseInt(value ?? '0', 10) || 0);
}

function userLabel(id: number | null, names: AdminNames): string | null {
  if (id === null) {
    return null;
  }
  // Actor 0 is the bot itself: automatic actions (vpn-kick.ts).
  if (id === 0) {
    return 'The bot';
  }
  const known = names.get(id);
  return formatTelegramUser(id, known?.username, known?.firstName);
}

export function toAuditEntryDto(entry: AuditLogEntry): AuditEntryDto {
  return {
    id: entry.id,
    at: entry.createdAt.toISOString(),
    actor:
      entry.actorTelegramId === 0
        ? 'The bot'
        : formatTelegramUser(
            entry.actorTelegramId,
            entry.actorUsername,
            entry.actorFirstName,
          ),
    action: entry.action,
    target: entry.target,
    server: entry.serverAlias,
    reason: entry.reason,
    source: entry.source,
    detail:
      entry.detailJson === null || entry.detailJson === undefined
        ? null
        : JSON.stringify(entry.detailJson, null, 2),
  };
}

function toNoteDto(
  note: PlayerNote,
  names: AdminNames,
  actor: MiniAppActor,
): NoteDto {
  return {
    id: note.id,
    kind: note.kind,
    value: note.value,
    note: note.note,
    watch: note.watch,
    author: userLabel(note.createdBy, names) ?? '',
    editable: note.createdBy === actor.telegramId || hasRole(actor, 'admin'),
    updatedAt: note.updatedAt.toISOString(),
  };
}

function toReportDto(
  report: Report,
  names: AdminNames,
  candidates: PlayerDto[],
): ReportDto {
  return {
    id: report.id,
    server: report.serverAlias,
    reporter: report.reporterName,
    target: report.targetName,
    reason: report.reason,
    status: report.status,
    count: report.count,
    createdAt: report.createdAt.toISOString(),
    lastReportedAt: report.lastReportedAt.toISOString(),
    resolvedBy: userLabel(report.resolvedBy, names),
    resolvedAt: report.resolvedAt?.toISOString() ?? null,
    outcome: report.outcome,
    candidates,
  };
}

/** How notes file an identity: GUID and IP as they are, a name lower case without colour codes. */
function noteIdentity(
  kind: unknown,
  value: unknown,
): { kind: NoteKind; value: string } {
  const text = typeof value === 'string' ? value.trim() : '';
  if (kind === 'guid' && /^[0-9A-Za-z]{1,32}$/.test(text) && text !== '0') {
    return { kind, value: text };
  }
  if (kind === 'ip' && isIpv4(text)) {
    return { kind, value: text };
  }
  if (kind === 'name') {
    const name = noteNameKey(text).slice(0, 64);
    if (name) {
      return { kind, value: name };
    }
  }
  throw new ApiProblem(
    400,
    'bad_request',
    'Enter a GUID (not 0), an IPv4 address or a player name.',
  );
}

function noteText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().slice(0, MAX_NOTE) : '';
  if (!text) {
    throw new ApiProblem(400, 'bad_request', 'Write something in the note.');
  }
  return text;
}

/** Dashboards, the report queue, player notes and a player's history (docs/PLAN-miniapp.md §6.4). */
export function registerInsightRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  state: MiniAppState,
): void {
  app.get(
    '/servers/:server/dashboard',
    async (
      request: FastifyRequest<{
        Params: { server: string };
        Querystring: { hours?: string };
      }>,
    ): Promise<DashboardResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const asked = Number(request.query.hours);
      const hours = DASHBOARD_HOURS.includes(asked) ? asked : 24;
      const until = new Date();
      const since = new Date(until.getTime() - hours * 3_600_000);
      const [live, snapshots] = await Promise.all([
        // Offline is an answer here: the history is still worth showing.
        rcon.getStatus().catch(() => null),
        deps.adminStore.listServerSnapshots(alias, since),
      ]);
      const maxClients = Number.parseInt(
        live?.cvars['sv_maxclients'] ?? '',
        10,
      );
      const hostname = live?.cvars['sv_hostname'];
      return {
        server: alias,
        online: live !== null,
        hostname: hostname ? stripColorCodes(hostname).trim() : null,
        map: live?.cvars['mapname'] ?? null,
        gametype: live?.cvars['g_gametype'] ?? live?.cvars['gametype'] ?? null,
        players: live?.players.length ?? 0,
        maxClients: Number.isNaN(maxClients) ? null : maxClients,
        hours,
        history: summarizeSnapshots(snapshots, since, until),
      };
    },
  );

  // ── Reports ──────────────────────────────────────────────────────────────────────────────

  /** Who an open report could be about, on servers that answer. */
  async function candidatesByServer(reports: Report[]) {
    const open = reports.filter((report) => report.status === 'open');
    const aliases = [...new Set(open.map((report) => report.serverAlias))];
    const entries = await Promise.all(
      aliases.map(async (alias) => {
        const players = await deps.rconClients
          .get(alias)
          ?.status()
          .then((status) => status.players)
          .catch(() => []);
        return [alias, players ?? []] as const;
      }),
    );
    return new Map(entries);
  }

  app.get(
    '/reports',
    async (
      request: FastifyRequest<{
        Querystring: { resolved?: string; server?: string; offset?: string };
      }>,
    ): Promise<ReportsResponse> => {
      const rows = await deps.adminStore.searchReports({
        resolved: request.query.resolved === '1',
        serverAlias: request.query.server || undefined,
        limit: PAGE_SIZE + 1,
        offset: offsetParam(request.query.offset),
      });
      const page = rows.slice(0, PAGE_SIZE);
      const [names, players] = await Promise.all([
        adminNames(deps),
        candidatesByServer(page),
      ]);
      const items = await Promise.all(
        page.map(async (report) =>
          toReportDto(
            report,
            names,
            report.status === 'open'
              ? await state.playerDtos(
                  matchPlayersByName(
                    report.targetName,
                    players.get(report.serverAlias) ?? [],
                    (player) => stripColorCodes(player.name),
                  ),
                )
              : [],
          ),
        ),
      );
      return {
        items,
        more: rows.length > PAGE_SIZE,
      };
    },
  );

  app.post(
    '/reports/:id/resolve',
    { config: { action: true } },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: ResolveReportRequest;
      }>,
    ): Promise<ActionResponse> => {
      const id = Number(request.params.id);
      const status = request.body?.status;
      if (
        !Number.isInteger(id) ||
        (status !== 'handled' && status !== 'ignored')
      ) {
        throw new ApiProblem(400, 'bad_request', 'Unknown report or action.');
      }
      const outcome =
        typeof request.body.outcome === 'string'
          ? request.body.outcome.trim().slice(0, 100) || null
          : null;
      const report = await deps.reportQueue.resolve(id, {
        status,
        resolvedBy: request.actor.telegramId,
        outcome: outcome ?? (status === 'ignored' ? 'Ignored' : 'Handled'),
      });
      if (!report) {
        throw new ApiProblem(
          409,
          'report_closed',
          'Someone else has dealt with this report already.',
        );
      }
      await deps.adminStore.recordAuditLog({
        actorTelegramId: request.actor.telegramId,
        action: status === 'ignored' ? 'report_ignored' : 'report_handled',
        target: report.targetName,
        serverAlias: report.serverAlias,
        reason: report.reason,
        source: 'miniapp',
        detailJson: { reportId: id, outcome },
      });
      await state.integrations
        .closeReportCard?.(
          id,
          `${report.targetName}'s report: ${report.outcome} by ${actorLabel(request.actor)} in the app.`,
        )
        .catch((error: unknown) => {
          console.error(`Mini App: closing report card ${id} failed:`, error);
        });
      return {
        message: status === 'ignored' ? 'Ignored.' : 'Marked as handled.',
      };
    },
  );

  // ── Notes & watchlist ────────────────────────────────────────────────────────────────────

  app.get(
    '/notes',
    async (
      request: FastifyRequest<{
        Querystring: { q?: string; watch?: string; offset?: string };
      }>,
    ): Promise<NotesResponse> => {
      const rows = await deps.adminStore.searchPlayerNotes({
        query: request.query.q?.slice(0, 64) || undefined,
        watchOnly: request.query.watch === '1',
        limit: PAGE_SIZE + 1,
        offset: offsetParam(request.query.offset),
      });
      const names = await adminNames(deps);
      return {
        items: rows
          .slice(0, PAGE_SIZE)
          .map((note) => toNoteDto(note, names, request.actor)),
        more: rows.length > PAGE_SIZE,
      };
    },
  );

  app.post(
    '/notes',
    { config: { action: true } },
    async (
      request: FastifyRequest<{ Body: AddNoteRequest }>,
      reply,
    ): Promise<NoteDto> => {
      const body = request.body ?? ({} as AddNoteRequest);
      const identity = noteIdentity(body.kind, body.value);
      const note = await deps.adminStore.addPlayerNote({
        ...identity,
        note: noteText(body.note),
        watch: body.watch === true,
        createdBy: request.actor.telegramId,
      });
      state.invalidateNotes();
      await deps.adminStore.recordAuditLog({
        actorTelegramId: request.actor.telegramId,
        action: 'note_add',
        target: identity.value,
        source: 'miniapp',
        detailJson: { id: note.id, kind: identity.kind, watch: note.watch },
      });
      reply.code(201);
      return toNoteDto(note, await adminNames(deps), request.actor);
    },
  );

  /** A note its author wrote, or any note for an admin. */
  async function editableNote(
    request: FastifyRequest<{ Params: { id: string } }>,
  ) {
    const id = Number(request.params.id);
    const note = Number.isInteger(id)
      ? await deps.adminStore.getPlayerNote(id)
      : undefined;
    if (!note) {
      throw new ApiProblem(404, 'not_found', 'No such note.');
    }
    if (
      note.createdBy !== request.actor.telegramId &&
      !hasRole(request.actor, 'admin')
    ) {
      throw new ApiProblem(
        403,
        'forbidden',
        "Only its author or an admin can change someone's note.",
      );
    }
    return note;
  }

  app.patch(
    '/notes/:id',
    { config: { action: true } },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: UpdateNoteRequest;
      }>,
    ): Promise<NoteDto> => {
      const note = await editableNote(request);
      const body = request.body ?? {};
      const updated = await deps.adminStore.updatePlayerNote(note.id, {
        ...(body.note === undefined ? {} : { note: noteText(body.note) }),
        ...(typeof body.watch === 'boolean' ? { watch: body.watch } : {}),
      });
      if (!updated) {
        throw new ApiProblem(404, 'not_found', 'No such note.');
      }
      state.invalidateNotes();
      await deps.adminStore.recordAuditLog({
        actorTelegramId: request.actor.telegramId,
        action: 'note_edit',
        target: note.value,
        source: 'miniapp',
        detailJson: {
          id: note.id,
          before: { note: note.note, watch: note.watch },
          after: { note: updated.note, watch: updated.watch },
        },
      });
      return toNoteDto(updated, await adminNames(deps), request.actor);
    },
  );

  app.delete(
    '/notes/:id',
    { config: { action: true } },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
    ): Promise<ActionResponse> => {
      const note = await editableNote(request);
      await deps.adminStore.deletePlayerNote(note.id);
      state.invalidateNotes();
      await deps.adminStore.recordAuditLog({
        actorTelegramId: request.actor.telegramId,
        action: 'note_delete',
        target: note.value,
        source: 'miniapp',
        detailJson: { id: note.id, note: note.note },
      });
      return { message: 'Note deleted.' };
    },
  );

  // ── One player's history, like the report card's "More info" ────────────────────────────

  app.get(
    '/servers/:server/player-history',
    async (
      request: FastifyRequest<{
        Params: { server: string };
        Querystring: { name?: string; guid?: string; ip?: string };
      }>,
    ): Promise<PlayerHistoryResponse> => {
      const alias = request.params.server;
      serverParam(state, alias);
      const name = request.query.name?.slice(0, 128) ?? '';
      const plainName = stripColorCodes(name).trim();
      const guid = request.query.guid || undefined;
      const ip = request.query.ip || undefined;

      const [notes, guidBans, nameBans, ipBans, actions, names] =
        await Promise.all([
          deps.adminStore.findPlayerNotes([
            ...(plainName
              ? [{ kind: 'name' as const, value: noteNameKey(plainName) }]
              : []),
            ...(guid ? [{ kind: 'guid' as const, value: guid }] : []),
            ...(ip ? [{ kind: 'ip' as const, value: ip }] : []),
          ]),
          guid ? deps.banStore.listBansByGuid(guid, HISTORY_LIMIT) : [],
          name ? deps.banStore.listBansByName(name, HISTORY_LIMIT) : [],
          ip ? deps.banStore.listIpBansByIp(ip, HISTORY_LIMIT) : [],
          name
            ? deps.adminStore.listAuditLogForTarget(alias, name, HISTORY_LIMIT)
            : [],
          adminNames(deps),
        ]);
      const uniqueBans = [
        ...new Map(
          [...guidBans, ...nameBans].map((ban) => [ban.id, ban]),
        ).values(),
      ];
      return {
        notes: notes.map((note) => toNoteDto(note, names, request.actor)),
        bans: [
          ...uniqueBans.map((ban) => toGuidBanDto(ban, names)),
          ...ipBans.map((ban) => toIpBanDto(ban, names, deps)),
        ].sort((a, b) => b.bannedAt.localeCompare(a.bannedAt)),
        actions: actions.map(toAuditEntryDto),
      };
    },
  );
}
