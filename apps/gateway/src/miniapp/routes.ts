import type { AdminRole } from '@cod2admin/admin-store';
import type { Ban, BanChanges, BanIp } from '@cod2admin/ban-store';
import { isBanFileSafeName } from '@cod2admin/rcon-client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { STOCK_MAPS } from '../lib/commands/maps.js';
import { formatDuration } from '../lib/commands/tempban.js';
import type { GatewayDeps } from '../lib/deps.js';
import { executeModerationAction, type ModerationActionKind } from '../lib/moderation-actions.js';
import { displayName } from '../lib/commands/players.js';
import { sanitizeRconArg } from '../lib/sanitize.js';
import { isIpv4, liftBan } from '../lib/unban-actions.js';
import { getRunningVersion } from '../lib/version.js';
import type {
  ActionResponse,
  AddBanRequest,
  ApiError,
  BanKind,
  BansResponse,
  ChatResponse,
  ConsoleResponse,
  MapsResponse,
  MeResponse,
  ModerationRequest,
  SayRequest,
  StatusResponse,
  TellRequest,
  UnbanRequest,
  UnbanResponse,
  UpdateBanRequest,
  UpdateBanResponse,
} from './api-types.js';
import { actorLabel, type MiniAppActor } from './auth.js';
import { toGuidBanDto, toIpBanDto, type AdminNames } from './dto.js';
import type { MiniAppState } from './state.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The least role a route needs (docs/PLAN.md §4 — the same gates as the chat commands). */
    minRole?: AdminRole;
    /** Counts against the per-user action limit (state.ts). */
    action?: boolean;
  }
  interface FastifyRequest {
    actor: MiniAppActor;
  }
}

export const BANS_PAGE_SIZE = 50;
const MAX_TEMPBAN_MINUTES = 365 * 24 * 60;
const MAX_UNBAN_TARGETS = 50;
const MAX_CHAT_MESSAGE = 128;
const MAX_CONSOLE_COMMAND = 512;

/** An error the client should show as-is. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function serverParam(state: MiniAppState, alias: string) {
  const rcon = state.rcon(alias);
  if (!rcon) {
    throw new ApiProblem(404, 'unknown_server', `There's no server "${alias}" any more.`);
  }
  return rcon;
}

/** Text that goes into a game command: no line breaks, `;` or `"` (sanitize.ts), not empty. */
function requiredText(value: unknown, field: string, maxLength = MAX_CHAT_MESSAGE): string {
  const text = typeof value === 'string' ? sanitizeRconArg(value).slice(0, maxLength) : '';
  if (!text) {
    throw new ApiProblem(400, 'bad_request', `${field} is required.`);
  }
  return text;
}

function optionalReason(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
}

function durationMs(minutes: unknown): number | undefined {
  if (minutes === undefined || minutes === null) {
    return undefined;
  }
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TEMPBAN_MINUTES) {
    throw new ApiProblem(400, 'bad_request', 'The duration must be between 1 minute and a year.');
  }
  return minutes * 60_000;
}

async function adminNames(deps: GatewayDeps): Promise<AdminNames> {
  const admins = await deps.adminStore.listAdmins();
  return new Map(admins.map((admin) => [admin.telegramId, { username: admin.username, firstName: admin.firstName }]));
}

/** The server to open first: `/setdefault`'s if it's still there, else the one from `.env`. */
async function defaultServer(deps: GatewayDeps): Promise<string> {
  const chosen = await deps.adminStore.getDefaultServer();
  if (chosen && deps.rconClients.has(chosen.alias)) {
    return chosen.alias;
  }
  if (deps.rconClients.has(deps.bootstrapServerAlias)) {
    return deps.bootstrapServerAlias;
  }
  return deps.rconClients.keys().next().value ?? deps.bootstrapServerAlias;
}

type Params<T> = FastifyRequest<{ Params: T }>;

/**
 * The Mini App's REST API (docs/PLAN-miniapp.md §6.1–§6.3), mounted under `/api` behind the
 * auth hook in server.ts. Every action goes through the same code the chat commands use —
 * `executeModerationAction`, `liftBan`, the stores — and is audit-logged with source `miniapp`.
 */
export function registerRoutes(app: FastifyInstance, deps: GatewayDeps, state: MiniAppState): void {
  const audit = (request: FastifyRequest, entry: { action: string; target?: string | null; serverAlias?: string | null; reason?: string | null; detailJson?: unknown }) =>
    deps.adminStore.recordAuditLog({ actorTelegramId: request.actor.telegramId, source: 'miniapp', ...entry });

  app.get('/me', async (request): Promise<MeResponse> => {
    const { actor } = request;
    return {
      user: { id: actor.telegramId, username: actor.username, firstName: actor.firstName },
      role: actor.role,
      version: getRunningVersion(),
      servers: [...deps.rconClients.keys()].map((alias) => ({ alias, chat: deps.logTailers.has(alias) })),
      defaultServer: await defaultServer(deps),
    };
  });

  // ── Server status & moderation (§6.1) ────────────────────────────────────────────────────

  app.get('/servers/:server/status', async (request: Params<{ server: string }>): Promise<StatusResponse> => {
    serverParam(state, request.params.server);
    const status = await state.fetchStatus(request.params.server);
    state.statusWatcher(request.params.server).publish(status);
    return status;
  });

  for (const kind of ['kick', 'tempban', 'ban'] as const satisfies readonly ModerationActionKind[]) {
    app.post(
      `/servers/:server/players/:num/${kind}`,
      { config: { minRole: kind === 'ban' ? 'admin' : 'moderator', action: true } },
      async (request: FastifyRequest<{ Params: { server: string; num: string }; Body: ModerationRequest }>): Promise<ActionResponse> => {
        const alias = request.params.server;
        const rcon = serverParam(state, alias);
        const num = Number(request.params.num);
        const body = request.body ?? ({} as ModerationRequest);
        const duration = kind === 'tempban' ? durationMs(body.durationMinutes) : undefined;

        // The slot may have changed hands since the admin's list was drawn — act only on the
        // player they saw.
        const { players } = await rcon.status();
        const player = players.find((candidate) => candidate.num === num);
        if (!player || player.name !== body.name) {
          const who = typeof body.name === 'string' ? displayName({ num, name: body.name, score: 0, ping: 0 }) : 'That player';
          throw new ApiProblem(409, 'player_changed', `${who} isn't in slot ${num} any more — refresh the list.`);
        }

        const result = await executeModerationAction(
          kind,
          { num: player.num, name: player.name, guid: player.guid, ip: player.ip },
          {
            serverAlias: alias,
            rcon,
            banStore: deps.banStore,
            adminStore: deps.adminStore,
            actorTelegramId: request.actor.telegramId,
            reason: optionalReason(body.reason),
            source: 'miniapp',
            durationMs: duration,
          },
        );
        const forHowLong = result.durationMs ? ` for ${formatDuration(result.durationMs)}` : '';
        return { message: `${result.label} ${displayName(player)}${forHowLong}.` };
      },
    );
  }

  // ── Maps (§6.1) ──────────────────────────────────────────────────────────────────────────

  app.get('/servers/:server/maps', { config: { minRole: 'admin' } }, async (request: Params<{ server: string }>): Promise<MapsResponse> => {
    const rcon = serverParam(state, request.params.server);
    const [status, rotation, installed] = await Promise.all([
      rcon.status(),
      rcon.getMapRotation(),
      rcon.getInstalledMaps().catch((error: unknown) => {
        console.error('Mini App: listing installed maps failed:', error);
        return [] as string[];
      }),
    ]);
    const inRotation = new Set(rotation);
    return {
      current: status.mapName ?? null,
      rotation,
      others: installed.filter((name) => !inRotation.has(name)).map((name) => ({ name, stock: STOCK_MAPS.has(name) })),
    };
  });

  app.post(
    '/servers/:server/map',
    { config: { minRole: 'admin', action: true } },
    async (request: FastifyRequest<{ Params: { server: string }; Body: { map?: string } }>): Promise<ActionResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const typed = requiredText(request.body?.map, 'A map name');
      const installed = await rcon.getInstalledMaps().catch(() => [] as string[]);
      const mapName = installed.length > 0 ? installed.find((name) => name.toLowerCase() === typed.toLowerCase()) : typed;
      if (!mapName) {
        throw new ApiProblem(404, 'unknown_map', `There's no map "${typed}" on ${alias}.`);
      }
      await rcon.map(mapName);
      await audit(request, { action: 'map', target: mapName, serverAlias: alias });
      return { message: `Changing map to ${mapName}…` };
    },
  );

  // ── Raw console, owner only (§6.1) ───────────────────────────────────────────────────────

  app.post(
    '/servers/:server/console',
    { config: { minRole: 'owner', action: true } },
    async (request: FastifyRequest<{ Params: { server: string }; Body: { command?: string } }>): Promise<ConsoleResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      // Like `/rcon`, the one deliberate exception to sanitizing — but still a single line.
      const command = typeof request.body?.command === 'string' ? request.body.command.replace(/[\r\n]+/g, ' ').trim() : '';
      if (!command || command.length > MAX_CONSOLE_COMMAND) {
        throw new ApiProblem(400, 'bad_request', 'Type a command (up to 512 characters).');
      }
      const output = await rcon.rcon(command);
      await audit(request, { action: 'rcon', target: command, serverAlias: alias, detailJson: { command } });
      return { output };
    },
  );

  // ── Chat (§6.2) ──────────────────────────────────────────────────────────────────────────

  app.get('/servers/:server/chat', async (request: Params<{ server: string }>): Promise<ChatResponse> => {
    serverParam(state, request.params.server);
    const feed = state.chatFeed(request.params.server);
    return feed ? { available: true, lines: await feed.history() } : { available: false, lines: [] };
  });

  app.post(
    '/servers/:server/say',
    { config: { minRole: 'admin', action: true } },
    async (request: FastifyRequest<{ Params: { server: string }; Body: SayRequest }>): Promise<ActionResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const message = requiredText(request.body?.message, 'A message');
      await rcon.say(message);
      await audit(request, { action: 'say', target: message, serverAlias: alias });
      state.chatFeed(alias)?.addAdminLine({ channel: 'say', num: null, name: actorLabel(request.actor), message });
      return { message: 'Sent.' };
    },
  );

  app.post(
    '/servers/:server/tell',
    { config: { minRole: 'admin', action: true } },
    async (request: FastifyRequest<{ Params: { server: string }; Body: TellRequest }>): Promise<ActionResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const body = request.body ?? ({} as TellRequest);
      const message = requiredText(body.message, 'A message');
      const { players } = await rcon.status();
      const player = players.find((candidate) => candidate.num === body.num);
      if (!player || player.name !== body.name) {
        throw new ApiProblem(409, 'player_changed', "That player isn't connected any more.");
      }
      await rcon.tell(player.num, message);
      await audit(request, { action: 'tell', target: player.name, serverAlias: alias, detailJson: { message } });
      state.chatFeed(alias)?.addAdminLine({ channel: 'tell', num: player.num, name: actorLabel(request.actor), message, to: player.name });
      return { message: `Sent to ${displayName(player)}.` };
    },
  );

  // ── Bans (§6.3) — global, like /bans and /unban ─────────────────────────────────────────

  app.get(
    '/bans',
    { config: { minRole: 'admin' } },
    async (request: FastifyRequest<{ Querystring: { kind?: string; q?: string; lifted?: string; offset?: string } }>): Promise<BansResponse> => {
      const kind: BanKind = request.query.kind === 'ip' ? 'ip' : 'guid';
      const filter = {
        query: request.query.q?.slice(0, 64),
        includeLifted: request.query.lifted === '1' || request.query.lifted === 'true',
        limit: BANS_PAGE_SIZE + 1,
        offset: Math.max(0, Number.parseInt(request.query.offset ?? '0', 10) || 0),
      };
      const names = await adminNames(deps);
      const items =
        kind === 'ip'
          ? (await deps.banStore.searchIpBans(filter)).map((ban) => toIpBanDto(ban, names, deps))
          : (await deps.banStore.searchBans(filter)).map((ban) => toGuidBanDto(ban, names));
      return { items: items.slice(0, BANS_PAGE_SIZE), more: items.length > BANS_PAGE_SIZE };
    },
  );

  app.patch(
    '/bans/:kind/:id',
    { config: { minRole: 'admin', action: true } },
    async (request: FastifyRequest<{ Params: { kind: string; id: string }; Body: UpdateBanRequest }>): Promise<UpdateBanResponse> => {
      const id = Number(request.params.id);
      const kind = request.params.kind;
      if ((kind !== 'guid' && kind !== 'ip') || !Number.isInteger(id)) {
        throw new ApiProblem(404, 'not_found', 'No such ban.');
      }
      const changes = parseBanChanges(request.body ?? {});
      const names = await adminNames(deps);

      if (kind === 'ip') {
        const before = await deps.banStore.getIpBan(id);
        if (!before) {
          throw new ApiProblem(404, 'not_found', 'No such ban.');
        }
        const after = (await deps.banStore.updateIpBan(id, changes))!;
        await auditBanEdit(request, before, after, before.ip);
        return { ban: toIpBanDto(after, names, deps) };
      }

      const before = await deps.banStore.getBan(id);
      if (!before) {
        throw new ApiProblem(404, 'not_found', 'No such ban.');
      }
      const after = (await deps.banStore.updateBan(id, changes))!;
      await auditBanEdit(request, before, after, before.guid ?? before.name);
      const warning = await dropFromBanFileIfNowTemporary(before, after);
      return { ban: toGuidBanDto(after, names), ...(warning ? { warning } : {}) };
    },
  );

  /**
   * A permanent GUID ban can also be in its server's `ban.txt` (moderation-actions.ts), where it
   * never expires. Once it's made temporary, take it out of there — the poller keeps the player
   * out until the new expiry instead.
   */
  async function dropFromBanFileIfNowTemporary(before: Ban, after: Ban): Promise<string | undefined> {
    const rcon = deps.rconClients.get(before.serverAlias);
    if (before.expiresAt !== null || after.expiresAt === null || before.unbannedAt || !isBanFileSafeName(before.name) || !rcon) {
      return undefined;
    }
    try {
      await rcon.unbanUser(before.name);
      return undefined;
    } catch (error) {
      console.error(`Mini App: removing ${before.name} from ${before.serverAlias}'s ban.txt failed:`, error);
      return `${before.serverAlias} didn't answer, so its ban.txt may still block this player after the ban expires. Unban them then if they still can't join.`;
    }
  }

  async function auditBanEdit(request: FastifyRequest, before: Ban | BanIp, after: Ban | BanIp, target: string): Promise<void> {
    await audit(request, {
      action: 'editban',
      target,
      serverAlias: before.serverAlias,
      reason: after.reason,
      detailJson: {
        id: before.id,
        before: { reason: before.reason, expiresAt: before.expiresAt?.toISOString() ?? null },
        after: { reason: after.reason, expiresAt: after.expiresAt?.toISOString() ?? null },
      },
    });
  }

  app.post(
    '/bans/unban',
    { config: { minRole: 'admin', action: true } },
    async (request: FastifyRequest<{ Body: UnbanRequest }>): Promise<UnbanResponse> => {
      const targets = [...new Set((request.body?.targets ?? []).filter((target) => typeof target === 'string').map(sanitizeRconArg).filter(Boolean))];
      if (targets.length === 0 || targets.length > MAX_UNBAN_TARGETS) {
        throw new ApiProblem(400, 'bad_request', `Pick between 1 and ${MAX_UNBAN_TARGETS} bans to lift.`);
      }
      const results = [];
      for (const target of targets) {
        const result = await liftBan(target, deps, { telegramId: request.actor.telegramId, source: 'miniapp' });
        results.push({ target, lifted: result.lifted, unanswered: result.unanswered });
      }
      return { results };
    },
  );

  app.post('/bans', { config: { minRole: 'admin', action: true } }, async (request: FastifyRequest<{ Body: AddBanRequest }>, reply: FastifyReply): Promise<ActionResponse> => {
    const body = request.body ?? ({} as AddBanRequest);
    serverParam(state, body.server);
    const duration = durationMs(body.durationMinutes);
    const expiresAt = duration ? new Date(Date.now() + duration) : null;
    const reason = optionalReason(body.reason);
    const action = expiresAt ? 'tempban' : 'ban';
    const forHowLong = duration ? ` for ${formatDuration(duration)}` : '';

    if (body.kind === 'ip') {
      const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
      if (!isIpv4(ip)) {
        throw new ApiProblem(400, 'bad_request', 'Enter an IPv4 address, like 203.0.113.7.');
      }
      await deps.banStore.recordIpBan({ serverAlias: body.server, ip, reason, bannedBy: request.actor.telegramId, expiresAt });
      await audit(request, { action, target: ip, serverAlias: body.server, reason, detailJson: { ip, manual: true } });
      reply.code(201);
      return { message: `IP ${ip} banned${forHowLong}. If they're online, they're kicked within seconds.` };
    }
    if (body.kind === 'guid') {
      const guid = typeof body.guid === 'string' ? body.guid.trim() : '';
      if (!/^[0-9A-Za-z]{1,32}$/.test(guid) || guid === '0') {
        throw new ApiProblem(400, 'bad_request', 'Enter the GUID the server shows (not 0).');
      }
      const name = requiredText(body.name, "The player's name");
      await deps.banStore.recordBan({ serverAlias: body.server, guid, name, reason, bannedBy: request.actor.telegramId, expiresAt });
      await audit(request, { action, target: name, serverAlias: body.server, reason, detailJson: { guid, manual: true } });
      reply.code(201);
      return { message: `GUID ${guid} banned${forHowLong}. If they're online, they're kicked within seconds.` };
    }
    throw new ApiProblem(400, 'bad_request', 'Choose an IP or GUID ban.');
  });
}

function parseBanChanges(body: UpdateBanRequest): BanChanges {
  const changes: BanChanges = {};
  if (body.reason !== undefined) {
    changes.reason = optionalReason(body.reason);
  }
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null) {
      changes.expiresAt = null;
    } else {
      const expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        throw new ApiProblem(400, 'bad_request', 'The new expiry must be in the future — or lift the ban instead.');
      }
      changes.expiresAt = expiresAt;
    }
  }
  return changes;
}

export function apiError(code: string, message: string): ApiError {
  return { error: code, message };
}
