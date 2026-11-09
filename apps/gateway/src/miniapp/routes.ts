import { effectivePermissions } from '@cod2admin/admin-store';
import type { Ban, BanChanges, BanIp } from '@cod2admin/ban-store';
import { isBanFileSafeName } from '@cod2admin/rcon-client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { STOCK_MAPS } from '../lib/commands/maps.js';
import { formatDuration } from '../lib/commands/tempban.js';
import type { GatewayDeps } from '../lib/deps.js';
import {
  executeModerationAction,
  type ModerationActionKind,
} from '../lib/moderation-actions.js';
import { displayName } from '../lib/commands/players.js';
import { normalizeKnownName } from '../lib/known-players.js';
import { findMute, usableGuid } from '../lib/mute-enforcer.js';
import { sanitizeRconArg } from '../lib/sanitize.js';
import { isIpv4, liftBan } from '../lib/unban-actions.js';
import { getRunningVersion } from '../lib/version.js';
import type {
  ActionResponse,
  AddBanRequest,
  ApiError,
  BanKind,
  BansResponse,
  ChangeMapRequest,
  ChatResponse,
  ConsoleResponse,
  MapsResponse,
  MeResponse,
  ModerationRequest,
  Permission,
  MutesResponse,
  RotationRequest,
  SayRequest,
  StatusResponse,
  TellRequest,
  UnbanRequest,
  UnbanResponse,
  UpdateBanRequest,
  UpdateBanResponse,
} from './api-types.js';
import { ApiProblem } from './api-problem.js';
import { actorLabel, type MiniAppActor } from './auth.js';
import { toGuidBanDto, toIpBanDto, toMuteDto, type AdminNames } from './dto.js';
import { registerInsightRoutes } from './routes-insight.js';
import { registerManagementRoutes } from './routes-management.js';
import type { MiniAppState } from './state.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set when the route needs a permission. Absent: any staff member. */
    permission?: Permission;
    /** Counts against the per-user action limit (state.ts). */
    action?: boolean;
  }
  interface FastifyRequest {
    actor: MiniAppActor;
  }
}

export const BANS_PAGE_SIZE = 50;
/** The mode the Maps page picks first when the server has it (asked for by the CTF RUSSIA owner). */
export const DEFAULT_GAMETYPE = 'ctf';
const MAX_TEMPBAN_MINUTES = 365 * 24 * 60;
const MAX_UNBAN_TARGETS = 50;
const MAX_CHAT_MESSAGE = 128;
const MAX_CONSOLE_COMMAND = 512;

export { ApiProblem };

export function serverParam(state: MiniAppState, alias: string) {
  const rcon = state.rcon(alias);
  if (!rcon) {
    throw new ApiProblem(
      404,
      'unknown_server',
      `There's no server "${alias}" any more.`,
    );
  }
  return rcon;
}

/** Text that goes into a game command: no line breaks, `;` or `"` (sanitize.ts), not empty. */
export function requiredText(
  value: unknown,
  field: string,
  maxLength = MAX_CHAT_MESSAGE,
): string {
  const text =
    typeof value === 'string' ? sanitizeRconArg(value).slice(0, maxLength) : '';
  if (!text) {
    throw new ApiProblem(400, 'bad_request', `${field} is required.`);
  }
  return text;
}

function optionalReason(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 200)
    : null;
}

function durationMs(minutes: unknown): number | undefined {
  if (minutes === undefined || minutes === null) {
    return undefined;
  }
  if (
    typeof minutes !== 'number' ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_TEMPBAN_MINUTES
  ) {
    throw new ApiProblem(
      400,
      'bad_request',
      'The duration must be between 1 minute and a year.',
    );
  }
  return minutes * 60_000;
}

/**
 * A game mode from the client, checked before it goes into an RCON command: one of the server's
 * own modes (matched case-insensitively), or — if the server can't list them — any plain name.
 */
function resolveGametype(
  typed: unknown,
  gametypes: string[],
  alias: string,
): string {
  const name = typeof typed === 'string' ? typed.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
    throw new ApiProblem(400, 'bad_request', 'Pick a game mode.');
  }
  if (gametypes.length === 0) {
    return name;
  }
  const known = gametypes.find(
    (gametype) => gametype.toLowerCase() === name.toLowerCase(),
  );
  if (!known) {
    throw new ApiProblem(
      404,
      'unknown_gametype',
      `${alias} has no game mode "${name}".`,
    );
  }
  return known;
}

export async function adminNames(deps: GatewayDeps): Promise<AdminNames> {
  const admins = await deps.adminStore.listAdmins();
  return new Map(
    admins.map((admin) => [
      admin.telegramId,
      { username: admin.username, firstName: admin.firstName },
    ]),
  );
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
export function registerRoutes(
  app: FastifyInstance,
  deps: GatewayDeps,
  state: MiniAppState,
): void {
  const audit = (
    request: FastifyRequest,
    entry: {
      action: string;
      target?: string | null;
      serverAlias?: string | null;
      reason?: string | null;
      detailJson?: unknown;
    },
  ) =>
    deps.adminStore.recordAuditLog({
      actorTelegramId: request.actor.telegramId,
      source: 'miniapp',
      ...entry,
    });

  app.get('/me', async (request): Promise<MeResponse> => {
    const { actor } = request;
    return {
      user: {
        id: actor.telegramId,
        username: actor.username,
        firstName: actor.firstName,
      },
      isOwner: actor.isOwner,
      permissions: effectivePermissions(actor),
      version: getRunningVersion(),
      servers: [...deps.rconClients.keys()].map((alias) => ({
        alias,
        chat: deps.logTailers.has(alias),
      })),
      defaultServer: await defaultServer(deps),
      openReports: await deps.adminStore.countOpenReports(),
    };
  });

  // ── Server status & moderation (§6.1) ────────────────────────────────────────────────────

  app.get(
    '/servers/:server/status',
    async (request: Params<{ server: string }>): Promise<StatusResponse> => {
      serverParam(state, request.params.server);
      const status = await state.fetchStatus(request.params.server);
      state.statusWatcher(request.params.server).publish(status);
      return status;
    },
  );

  for (const kind of [
    'kick',
    'tempban',
    'ban',
  ] as const satisfies readonly ModerationActionKind[]) {
    app.post(
      `/servers/:server/players/:num/${kind}`,
      {
        config: { permission: kind, action: true },
      },
      async (
        request: FastifyRequest<{
          Params: { server: string; num: string };
          Body: ModerationRequest;
        }>,
      ): Promise<ActionResponse> => {
        const alias = request.params.server;
        const rcon = serverParam(state, alias);
        const num = Number(request.params.num);
        const body = request.body ?? ({} as ModerationRequest);
        const duration =
          kind === 'tempban' ? durationMs(body.durationMinutes) : undefined;

        // The slot may have changed hands since the admin's list was drawn — act only on the
        // player they saw.
        const { players } = await rcon.status();
        const player = players.find((candidate) => candidate.num === num);
        if (!player || player.name !== body.name) {
          const who =
            typeof body.name === 'string'
              ? displayName({ num, name: body.name, score: 0, ping: 0 })
              : 'That player';
          throw new ApiProblem(
            409,
            'player_changed',
            `${who} isn't in slot ${num} any more — refresh the list.`,
          );
        }

        const result = await executeModerationAction(
          kind,
          {
            num: player.num,
            name: player.name,
            guid: player.guid,
            ip: player.ip,
          },
          {
            serverAlias: alias,
            rcon,
            banStore: deps.banStore,
            adminStore: deps.adminStore,
            actorTelegramId: request.actor.telegramId,
            reason: optionalReason(body.reason),
            source: 'miniapp',
            durationMs: duration,
            chatTemplates: deps.chatTemplates,
          },
        );
        const forHowLong = result.durationMs
          ? ` for ${formatDuration(result.durationMs)}`
          : '';
        return {
          message: `${result.label} ${displayName(player)}${forHowLong}.`,
        };
      },
    );
  }

  // ── Known players: "mark as known" from a player's sheet ─────────────────────────────────

  /**
   * Adds the player's current provider network (ASN) and real GUID, whichever the entry lacks, to
   * the known list under their name: a new entry for a stranger, or more identity for a listed
   * name (the "kicked, but it was really them" case). The slot is checked against the name the admin saw.
   */
  app.post(
    '/servers/:server/players/:num/known',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{
        Params: { server: string; num: string };
        Body: { name?: string };
      }>,
      reply: FastifyReply,
    ): Promise<ActionResponse> => {
      const rcon = serverParam(state, request.params.server);
      const num = Number(request.params.num);
      const { players } = await rcon.status();
      const player = players.find((candidate) => candidate.num === num);
      if (!player || player.name !== request.body?.name) {
        throw new ApiProblem(
          409,
          'player_changed',
          "That player isn't connected any more.",
        );
      }
      const { asn, guid } = deps.knownPlayers.additions(player);
      const name = normalizeKnownName(player.name);
      const existing = deps.knownPlayers.entries.find((e) => e.name === name);
      if (asn === undefined && guid === undefined) {
        const known = existing?.asns.length || existing?.guids.length;
        throw new ApiProblem(
          known ? 409 : 422,
          known ? 'already' : 'unknown_network',
          known
            ? `${displayName(player)} is already known.`
            : "Couldn't find this player's provider network or GUID. Add the network by ASN under Known players.",
        );
      }
      await deps.adminStore.saveKnownPlayer({
        name,
        display: existing?.display ?? displayName(player),
        asns:
          asn === undefined
            ? (existing?.asns ?? [])
            : [...(existing?.asns ?? []), asn],
        guids:
          guid === undefined
            ? (existing?.guids ?? [])
            : [...(existing?.guids ?? []), guid],
        note: existing?.note ?? null,
        createdBy: request.actor.telegramId,
      });
      deps.knownPlayers.setEntries(await deps.adminStore.listKnownPlayers());
      await deps.adminStore.recordAuditLog({
        actorTelegramId: request.actor.telegramId,
        source: 'miniapp',
        action: 'known_add',
        target: name,
        serverAlias: request.params.server,
        detailJson: { asn: asn ?? null, guid: guid ?? null },
      });
      reply.code(201);
      const added = [
        asn === undefined ? '' : `AS${asn}`,
        guid === undefined ? '' : `GUID ${guid}`,
      ]
        .filter(Boolean)
        .join(' and ');
      return {
        message: existing
          ? `${added} added to ${existing.display}.`
          : `${displayName(player)} is now a known player (${added}).`,
      };
    },
  );

  // ── Mutes (issue #7) — global, like bans ────────────────────────────────────────────────

  app.post(
    '/servers/:server/players/:num/mute',
    { config: { permission: 'mute', action: true } },
    async (
      request: FastifyRequest<{
        Params: { server: string; num: string };
        Body: ModerationRequest;
      }>,
      reply: FastifyReply,
    ): Promise<ActionResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      if (!deps.logTailers.has(alias)) {
        throw new ApiProblem(
          409,
          'no_chat_feed',
          "A mute works by reading the chat, and the bot can't read this server's log.",
        );
      }
      const num = Number(request.params.num);
      const body = request.body ?? ({} as ModerationRequest);
      const duration = durationMs(body.durationMinutes);
      const { players } = await rcon.status();
      const player = players.find((candidate) => candidate.num === num);
      if (!player || player.name !== body.name) {
        throw new ApiProblem(
          409,
          'player_changed',
          "That player isn't connected any more.",
        );
      }
      if (findMute(await deps.banStore.listActiveMutes(), player)) {
        throw new ApiProblem(
          409,
          'already_muted',
          `${displayName(player)} is already muted.`,
        );
      }
      const reason = optionalReason(body.reason);
      await deps.banStore.recordMute({
        serverAlias: alias,
        name: player.name,
        guid: usableGuid(player.guid),
        ip: player.ip ?? null,
        reason,
        mutedBy: request.actor.telegramId,
        expiresAt: duration ? new Date(Date.now() + duration) : null,
      });
      await audit(request, {
        action: 'mute',
        target: player.name,
        serverAlias: alias,
        reason,
        detailJson: { ip: player.ip ?? null, guid: player.guid ?? null },
      });
      reply.code(201);
      const forHowLong = duration ? ` for ${formatDuration(duration)}` : '';
      return { message: `Muted ${displayName(player)}${forHowLong}.` };
    },
  );

  app.get('/mutes', async (): Promise<MutesResponse> => {
    const names = await adminNames(deps);
    return {
      items: (await deps.banStore.listActiveMutes()).map((mute) =>
        toMuteDto(mute, names),
      ),
    };
  });

  app.post(
    '/mutes/:id/unmute',
    { config: { permission: 'mute', action: true } },
    async (request: Params<{ id: string }>): Promise<ActionResponse> => {
      const mute = await deps.banStore.unmute(Number(request.params.id));
      if (!mute) {
        throw new ApiProblem(404, 'not_found', 'That mute is already gone.');
      }
      await audit(request, {
        action: 'unmute',
        target: mute.name,
        serverAlias: mute.serverAlias,
      });
      return { message: 'Unmuted.' };
    },
  );

  // ── Maps (§6.1) ──────────────────────────────────────────────────────────────────────────

  app.get(
    '/servers/:server/maps',
    { config: { permission: 'maps' } },
    async (request: Params<{ server: string }>): Promise<MapsResponse> => {
      const rcon = serverParam(state, request.params.server);
      const listOrNothing = (what: string) => (error: unknown) => {
        console.error(`Mini App: listing ${what} failed:`, error);
        return [] as string[];
      };
      const [info, rotation, installed, gametypes] = await Promise.all([
        rcon.getInfo(),
        rcon.getMapRotationEntries(),
        rcon.getInstalledMaps().catch(listOrNothing('installed maps')),
        rcon.getGametypes().catch(listOrNothing('game modes')),
      ]);
      const currentGametype = info['gametype'] ?? null;
      const inRotation = new Set(rotation.map((entry) => entry.map));
      const names =
        installed.length > 0
          ? installed
          : [...inRotation].sort((a, b) => a.localeCompare(b));
      return {
        current: info['mapname'] ?? null,
        currentGametype,
        gametypes,
        defaultGametype: gametypes.includes(DEFAULT_GAMETYPE)
          ? DEFAULT_GAMETYPE
          : currentGametype,
        rotation,
        maps: names.map((name) => ({
          name,
          stock: STOCK_MAPS.has(name),
          inRotation: inRotation.has(name),
        })),
      };
    },
  );

  app.post(
    '/servers/:server/map',
    { config: { permission: 'maps', action: true } },
    async (
      request: FastifyRequest<{
        Params: { server: string };
        Body: ChangeMapRequest;
      }>,
    ): Promise<ActionResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const typed = requiredText(request.body?.map, 'A map name');
      const typedGametype = request.body?.gametype;
      const [installed, gametypes] = await Promise.all([
        rcon.getInstalledMaps().catch(() => [] as string[]),
        typedGametype === undefined
          ? Promise.resolve([] as string[])
          : rcon.getGametypes().catch(() => [] as string[]),
      ]);
      const mapName =
        installed.length > 0
          ? installed.find((name) => name.toLowerCase() === typed.toLowerCase())
          : typed;
      if (!mapName) {
        throw new ApiProblem(
          404,
          'unknown_map',
          `There's no map "${typed}" on ${alias}.`,
        );
      }
      const gametype =
        typedGametype === undefined
          ? undefined
          : resolveGametype(typedGametype, gametypes, alias);
      await rcon.map(mapName, gametype);
      await audit(request, {
        action: 'map',
        target: gametype ? `${mapName} (${gametype})` : mapName,
        serverAlias: alias,
        detailJson: gametype ? { map: mapName, gametype } : undefined,
      });
      return {
        message: `Changing map to ${mapName}${gametype ? ` (${gametype.toUpperCase()})` : ''}…`,
      };
    },
  );

  const LEVEL_COMMANDS = {
    restart: { command: 'map_restart', done: 'Restarting the map' },
    fastrestart: { command: 'fast_restart', done: 'Restarting the round' },
    rotate: { command: 'map_rotate', done: 'Moving to the next map' },
  } as const;

  app.post(
    '/servers/:server/level',
    { config: { permission: 'maps', action: true } },
    async (
      request: FastifyRequest<{
        Params: { server: string };
        Body: { command?: string };
      }>,
    ): Promise<ActionResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const key = request.body?.command as keyof typeof LEVEL_COMMANDS;
      const level = Object.hasOwn(LEVEL_COMMANDS, key ?? '')
        ? LEVEL_COMMANDS[key]
        : undefined;
      if (!level) {
        throw new ApiProblem(400, 'bad_request', 'Unknown command.');
      }
      const before = await rcon.getInfo().catch(() => null);
      const answered = await rcon.levelCommand(level.command);
      // On a real server map_restart and map_rotate never answer: it's loading the level. Asking
      // again waits the load out (like `map()`), and for a rotate says whether the map moved.
      const after = answered ? null : await rcon.getInfo().catch(() => null);
      await audit(request, {
        action: level.command,
        serverAlias: alias,
        detailJson: { answered, map: after?.['mapname'] ?? null },
      });
      if (answered) {
        return { message: `${level.done}…` };
      }
      if (!after) {
        return {
          message: `Sent, but ${alias} hasn't come back yet. Check it in a moment.`,
        };
      }
      if (key === 'rotate') {
        return {
          message:
            after['mapname'] && after['mapname'] !== before?.['mapname']
              ? `Now on ${after['mapname']}.`
              : `${alias} is still on ${after['mapname'] ?? 'the same map'}. If the rotation has other maps, try again.`,
        };
      }
      return { message: `${level.done}… ${alias} is back up.` };
    },
  );

  app.put(
    '/servers/:server/rotation',
    { config: { permission: 'maps', action: true } },
    async (
      request: FastifyRequest<{
        Params: { server: string };
        Body: RotationRequest;
      }>,
    ): Promise<ActionResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const entries = parseRotation(request.body?.entries);
      const before = await rcon.getMapRotationEntries();
      await rcon.setCvar('sv_mapRotation', formatRotation(entries));
      const after = await rcon.getMapRotationEntries();
      if (JSON.stringify(after) !== JSON.stringify(entries)) {
        // Too long for the server's command buffer, most likely: don't leave half a rotation.
        await rcon.setCvar('sv_mapRotation', formatRotation(before));
        throw new ApiProblem(
          422,
          'rotation_not_applied',
          `${alias} didn't take the whole rotation, so the old one was put back. Try fewer maps.`,
        );
      }
      // The game plays out what's left of the old list from this one first.
      await rcon.setCvar('sv_mapRotationCurrent', '');
      await audit(request, {
        action: 'maprotation',
        serverAlias: alias,
        detailJson: { before, after: entries },
      });
      return {
        message:
          "Rotation saved. It lasts until the server restarts: to keep it, put it in the server's config too.",
      };
    },
  );

  // ── Raw console, owner only (§6.1) ───────────────────────────────────────────────────────

  app.post(
    '/servers/:server/console',
    { config: { permission: 'rcon', action: true } },
    async (
      request: FastifyRequest<{
        Params: { server: string };
        Body: { command?: string };
      }>,
    ): Promise<ConsoleResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      // Like `/rcon`, the one deliberate exception to sanitizing — but still a single line.
      const command =
        typeof request.body?.command === 'string'
          ? request.body.command.replace(/[\r\n]+/g, ' ').trim()
          : '';
      if (!command || command.length > MAX_CONSOLE_COMMAND) {
        throw new ApiProblem(
          400,
          'bad_request',
          'Type a command (up to 512 characters).',
        );
      }
      const output = await rcon.rcon(command);
      await audit(request, {
        action: 'rcon',
        target: command,
        serverAlias: alias,
        detailJson: { command },
      });
      return { output };
    },
  );

  // ── Chat (§6.2) ──────────────────────────────────────────────────────────────────────────

  app.get(
    '/servers/:server/chat',
    async (request: Params<{ server: string }>): Promise<ChatResponse> => {
      serverParam(state, request.params.server);
      const feed = state.chatFeed(request.params.server);
      return feed
        ? { available: true, lines: await feed.history() }
        : { available: false, lines: [] };
    },
  );

  app.post(
    '/servers/:server/say',
    { config: { permission: 'say', action: true } },
    async (
      request: FastifyRequest<{ Params: { server: string }; Body: SayRequest }>,
    ): Promise<ActionResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const message = requiredText(request.body?.message, 'A message');
      await rcon.say(message);
      await audit(request, {
        action: 'say',
        target: message,
        serverAlias: alias,
      });
      state.chatFeed(alias)?.addAdminLine({
        channel: 'say',
        num: null,
        name: actorLabel(request.actor),
        message,
      });
      return { message: 'Sent.' };
    },
  );

  app.post(
    '/servers/:server/tell',
    { config: { permission: 'say', action: true } },
    async (
      request: FastifyRequest<{
        Params: { server: string };
        Body: TellRequest;
      }>,
    ): Promise<ActionResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const body = request.body ?? ({} as TellRequest);
      const message = requiredText(body.message, 'A message');
      const { players } = await rcon.status();
      const player = players.find((candidate) => candidate.num === body.num);
      if (!player || player.name !== body.name) {
        throw new ApiProblem(
          409,
          'player_changed',
          "That player isn't connected any more.",
        );
      }
      await rcon.tell(player.num, message);
      await audit(request, {
        action: 'tell',
        target: player.name,
        serverAlias: alias,
        detailJson: { message },
      });
      state.chatFeed(alias)?.addAdminLine({
        channel: 'tell',
        num: player.num,
        name: actorLabel(request.actor),
        message,
        to: player.name,
      });
      return { message: `Sent to ${displayName(player)}.` };
    },
  );

  // ── Bans (§6.3) — global, like /bans and /unban ─────────────────────────────────────────

  app.get(
    '/bans',
    { config: { permission: 'ban' } },
    async (
      request: FastifyRequest<{
        Querystring: {
          kind?: string;
          q?: string;
          lifted?: string;
          offset?: string;
        };
      }>,
    ): Promise<BansResponse> => {
      const kind: BanKind = request.query.kind === 'ip' ? 'ip' : 'guid';
      const filter = {
        query: request.query.q?.slice(0, 64),
        includeLifted:
          request.query.lifted === '1' || request.query.lifted === 'true',
        limit: BANS_PAGE_SIZE + 1,
        offset: Math.max(
          0,
          Number.parseInt(request.query.offset ?? '0', 10) || 0,
        ),
      };
      const names = await adminNames(deps);
      const items =
        kind === 'ip'
          ? (await deps.banStore.searchIpBans(filter)).map((ban) =>
              toIpBanDto(ban, names, deps),
            )
          : (await deps.banStore.searchBans(filter)).map((ban) =>
              toGuidBanDto(ban, names),
            );
      return {
        items: items.slice(0, BANS_PAGE_SIZE),
        more: items.length > BANS_PAGE_SIZE,
      };
    },
  );

  app.patch(
    '/bans/:kind/:id',
    { config: { permission: 'ban', action: true } },
    async (
      request: FastifyRequest<{
        Params: { kind: string; id: string };
        Body: UpdateBanRequest;
      }>,
    ): Promise<UpdateBanResponse> => {
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
      return {
        ban: toGuidBanDto(after, names),
        ...(warning ? { warning } : {}),
      };
    },
  );

  /**
   * A permanent GUID ban can also be in its server's `ban.txt` (moderation-actions.ts), where it
   * never expires. Once it's made temporary, take it out of there — the poller keeps the player
   * out until the new expiry instead.
   */
  async function dropFromBanFileIfNowTemporary(
    before: Ban,
    after: Ban,
  ): Promise<string | undefined> {
    const rcon = deps.rconClients.get(before.serverAlias);
    if (
      before.expiresAt !== null ||
      after.expiresAt === null ||
      before.unbannedAt ||
      !isBanFileSafeName(before.name) ||
      !rcon
    ) {
      return undefined;
    }
    try {
      await rcon.unbanUser(before.name);
      return undefined;
    } catch (error) {
      console.error(
        `Mini App: removing ${before.name} from ${before.serverAlias}'s ban.txt failed:`,
        error,
      );
      return `${before.serverAlias} didn't answer, so its ban.txt may still block this player after the ban expires. Unban them then if they still can't join.`;
    }
  }

  async function auditBanEdit(
    request: FastifyRequest,
    before: Ban | BanIp,
    after: Ban | BanIp,
    target: string,
  ): Promise<void> {
    await audit(request, {
      action: 'editban',
      target,
      serverAlias: before.serverAlias,
      reason: after.reason,
      detailJson: {
        id: before.id,
        before: {
          reason: before.reason,
          expiresAt: before.expiresAt?.toISOString() ?? null,
        },
        after: {
          reason: after.reason,
          expiresAt: after.expiresAt?.toISOString() ?? null,
        },
      },
    });
  }

  app.post(
    '/bans/unban',
    { config: { permission: 'ban', action: true } },
    async (
      request: FastifyRequest<{ Body: UnbanRequest }>,
    ): Promise<UnbanResponse> => {
      const targets = [
        ...new Set(
          (request.body?.targets ?? [])
            .filter((target) => typeof target === 'string')
            .map(sanitizeRconArg)
            .filter(Boolean),
        ),
      ];
      if (targets.length === 0 || targets.length > MAX_UNBAN_TARGETS) {
        throw new ApiProblem(
          400,
          'bad_request',
          `Pick between 1 and ${MAX_UNBAN_TARGETS} bans to lift.`,
        );
      }
      const results = [];
      for (const target of targets) {
        const result = await liftBan(target, deps, {
          telegramId: request.actor.telegramId,
          source: 'miniapp',
        });
        results.push({
          target,
          lifted: result.lifted,
          unanswered: result.unanswered,
        });
      }
      return { results };
    },
  );

  app.post(
    '/bans',
    { config: { permission: 'ban', action: true } },
    async (
      request: FastifyRequest<{ Body: AddBanRequest }>,
      reply: FastifyReply,
    ): Promise<ActionResponse> => {
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
          throw new ApiProblem(
            400,
            'bad_request',
            'Enter an IPv4 address, like 203.0.113.7.',
          );
        }
        await deps.banStore.recordIpBan({
          serverAlias: body.server,
          ip,
          reason,
          bannedBy: request.actor.telegramId,
          expiresAt,
        });
        await audit(request, {
          action,
          target: ip,
          serverAlias: body.server,
          reason,
          detailJson: { ip, manual: true },
        });
        reply.code(201);
        return {
          message: `IP ${ip} banned${forHowLong}. If they're online, they're kicked within seconds.`,
        };
      }
      if (body.kind === 'guid') {
        const guid = typeof body.guid === 'string' ? body.guid.trim() : '';
        if (!/^[0-9A-Za-z]{1,32}$/.test(guid) || guid === '0') {
          throw new ApiProblem(
            400,
            'bad_request',
            'Enter the GUID the server shows (not 0).',
          );
        }
        const name = requiredText(body.name, "The player's name");
        await deps.banStore.recordBan({
          serverAlias: body.server,
          guid,
          name,
          reason,
          bannedBy: request.actor.telegramId,
          expiresAt,
        });
        await audit(request, {
          action,
          target: name,
          serverAlias: body.server,
          reason,
          detailJson: { guid, manual: true },
        });
        reply.code(201);
        return {
          message: `GUID ${guid} banned${forHowLong}. If they're online, they're kicked within seconds.`,
        };
      }
      throw new ApiProblem(400, 'bad_request', 'Choose an IP or GUID ban.');
    },
  );

  registerInsightRoutes(app, deps, state);
  registerManagementRoutes(app, deps, state);
}

const MAX_ROTATION_ENTRIES = 64;
const GAME_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

function parseRotation(value: unknown): RotationRequest['entries'] {
  const entries = Array.isArray(value) ? (value as unknown[]) : [];
  const seen = new Set<string>();
  const parsed = entries.map((entry) => {
    const { map, gametype } = (entry ?? {}) as Record<string, unknown>;
    if (
      typeof map !== 'string' ||
      !GAME_TOKEN.test(map) ||
      (gametype !== null &&
        (typeof gametype !== 'string' || !GAME_TOKEN.test(gametype)))
    ) {
      throw new ApiProblem(400, 'bad_request', 'A rotation entry is invalid.');
    }
    const key = `${map}|${gametype}`;
    if (seen.has(key)) {
      throw new ApiProblem(
        400,
        'bad_request',
        `${map} is in the rotation twice with the same mode.`,
      );
    }
    seen.add(key);
    return { map, gametype: gametype as string | null };
  });
  if (parsed.length === 0 || parsed.length > MAX_ROTATION_ENTRIES) {
    throw new ApiProblem(
      400,
      'bad_request',
      `A rotation needs between 1 and ${MAX_ROTATION_ENTRIES} maps.`,
    );
  }
  return parsed;
}

/** `gametype ctf map mp_toujane map mp_dawnville gametype tdm map mp_burgundy` */
function formatRotation(entries: RotationRequest['entries']): string {
  const tokens: string[] = [];
  let current: string | null = null;
  for (const { map, gametype } of entries) {
    if (gametype && gametype !== current) {
      tokens.push('gametype', gametype);
      current = gametype;
    }
    tokens.push('map', map);
  }
  return tokens.join(' ');
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
      if (
        Number.isNaN(expiresAt.getTime()) ||
        expiresAt.getTime() <= Date.now()
      ) {
        throw new ApiProblem(
          400,
          'bad_request',
          'The new expiry must be in the future — or lift the ban instead.',
        );
      }
      changes.expiresAt = expiresAt;
    }
  }
  return changes;
}

export function apiError(code: string, message: string): ApiError {
  return { error: code, message };
}
