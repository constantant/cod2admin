import {
  ADMIN_PERMISSIONS,
  effectivePermissions,
  MODERATOR_PERMISSIONS,
  OWNER_GRANTED_PERMISSIONS,
  PERMISSIONS,
  PermissionError,
  resolvePermissionGrant,
  type Admin,
  type AuditSource,
  type Permission,
} from '@cod2admin/admin-store';
import { stripColorCodes } from '@cod2admin/rcon-client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  checkServer,
  parseAddServerArgs,
  saveCheckedServer,
} from '../lib/commands/addserver.js';
import {
  describeLogProblem,
  describeLogSearchFailure,
} from '../lib/commands/findlog.js';
import { loadRouteSettings } from '../lib/commands/relays.js';
import { forgetServer } from '../lib/commands/removeserver.js';
import { settleApplyProblem, stageRelease } from '../lib/commands/update.js';
import {
  KNOWN_PLAYERS_SETTING_KEY,
  normalizeKnownName,
} from '../lib/known-players.js';
import { parseAsn } from '../lib/commands/vpnnets.js';
import { cannotManageReason, mayManageAdmin } from '../lib/admin-rules.js';
import type { GatewayDeps } from '../lib/deps.js';
import {
  findGameLog,
  inspectLogFile,
  readLiveServerInfo,
} from '../lib/find-game-log.js';
import { detectBotRuntime, unreadableLogHelp } from '../lib/log-access-help.js';
import { stopReportTailer } from '../lib/report-tailers.js';
import {
  describeRoute,
  DIRECT_TELEGRAM_ROOT,
  normalizeRelayUrl,
  ROUTES_SETTING_KEY,
  routesFrom,
  type TelegramRouteSettings,
} from '../lib/telegram-routes.js';
import { formatTelegramUser } from '../lib/telegram-user.js';
import { runApplyUpdate } from '../lib/update-apply.js';
import { getRunningVersion, isNewerVersion } from '../lib/version.js';
import {
  applyChatTemplates,
  CHAT_TEMPLATES_SETTING_KEY,
  chatTemplateLines,
} from '../lib/chat-templates.js';
import { normalizeExempt, VPN_KICK_SETTING_KEY } from '../lib/vpn-kick.js';
import {
  NO_VPN_LOOKUP,
  parseVpnNetworks,
  VPN_NETWORKS_SETTING_KEY,
  type VpnNetwork,
} from '../lib/vpn-ranges.js';
import { sanitizeRconArg } from '../lib/sanitize.js';
import { ApiProblem } from './api-problem.js';
import type {
  ActionResponse,
  AddAdminRequest,
  AddServerRequest,
  AdminsResponse,
  ApplyUpdateRequest,
  AuditResponse,
  CvarsResponse,
  LogRequest,
  LogResponse,
  Presets,
  ChatTemplatesResponse,
  ChatTemplatesUpdate,
  RelaysResponse,
  RelayTestResponse,
  ServersResponse,
  SetCvarRequest,
  UpdateStatusResponse,
  VpnResponse,
  KnownResponse,
} from './api-types.js';
import { hasPermission, type MiniAppActor } from './auth.js';
import { adminNames, serverParam } from './routes.js';
import { toAuditEntryDto } from './routes-insight.js';
import type { MiniAppState } from './state.js';

const AUDIT_PAGE_SIZE = 50;
const AUDIT_SOURCES: readonly AuditSource[] = [
  'telegram_button',
  'telegram_command',
  'auto',
  'miniapp',
  'mcp',
];
/** Would cut the bot off from the server it just changed. Everything else: the owner's call. */
const CVARS_NOT_FROM_HERE = new Set(['rcon_password']);
export const PRESETS_SETTING_KEY = 'miniapp.presets';
export const DEFAULT_PRESETS: Presets = {
  reasons: ['Cheating', 'Abusive language', 'Team killing', 'Spawn camping'],
  durations: [30, 120, 1440, 10_080, 43_200],
  messages: [],
};
const MAX_PRESETS = 20;
const MAX_PRESET_TEXT = 100;
const MAX_TEMPBAN_MINUTES = 365 * 24 * 60;

function presetTexts(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const texts = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => sanitizeRconArg(entry).slice(0, MAX_PRESET_TEXT))
    .filter(Boolean);
  return [...new Set(texts)].slice(0, MAX_PRESETS);
}

/** Whatever is stored or sent, cleaned up: this goes into game commands later. */
export function parsePresets(value: unknown): Presets {
  const { reasons, durations, messages } = (value ?? {}) as Partial<
    Record<keyof Presets, unknown>
  >;
  const minutes = Array.isArray(durations)
    ? durations.filter(
        (entry): entry is number =>
          Number.isInteger(entry) &&
          (entry as number) >= 1 &&
          (entry as number) <= MAX_TEMPBAN_MINUTES,
      )
    : DEFAULT_PRESETS.durations;
  return {
    reasons: presetTexts(reasons, DEFAULT_PRESETS.reasons),
    durations: [...new Set(minutes)]
      .sort((a, b) => a - b)
      .slice(0, MAX_PRESETS),
    messages: presetTexts(messages, DEFAULT_PRESETS.messages),
  };
}

function permissionList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new ApiProblem(
      400,
      'bad_request',
      'permissions must be a list of permission ids.',
    );
  }
  return value;
}

/** `resolvePermissionGrant`, with unknown ids as 400 and grant refusals as 403. */
function grantedPermissions(
  actor: MiniAppActor,
  targetPermissions: readonly Permission[],
  requested: readonly string[],
): Permission[] {
  try {
    return resolvePermissionGrant({
      actorIsOwner: actor.isOwner,
      actorPermissions: actor.permissions,
      targetPermissions,
      requested,
    });
  } catch (error) {
    if (error instanceof PermissionError) {
      const unknown = error.message.startsWith('Unknown permission:');
      throw new ApiProblem(
        unknown ? 400 : 403,
        unknown ? 'bad_request' : 'forbidden',
        error.message,
      );
    }
    throw error;
  }
}

/**
 * The rest of the chat bot's management commands, as an API: audit log, admins, servers, VPN
 * rules, game-chat lines, Telegram routes, self-update, plus presets and cvars. Same permission gates as the
 * commands, and the same stores, so a change made here shows there at once.
 */
export function registerManagementRoutes(
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

  // ── Audit log (owner, like /auditlog) ────────────────────────────────────────────────────

  app.get(
    '/audit',
    { config: { permission: 'audit' } },
    async (
      request: FastifyRequest<{
        Querystring: {
          q?: string;
          action?: string;
          server?: string;
          source?: string;
          actor?: string;
          days?: string;
          offset?: string;
        };
      }>,
    ): Promise<AuditResponse> => {
      const { q, action, server, source, actor, days, offset } = request.query;
      const dayCount = Number.parseInt(days ?? '', 10);
      const actorId = Number.parseInt(actor ?? '', 10);
      const [rows, actions] = await Promise.all([
        deps.adminStore.searchAuditLog({
          query: q?.slice(0, 64) || undefined,
          action: action || undefined,
          serverAlias: server || undefined,
          source: AUDIT_SOURCES.find((known) => known === source),
          actorTelegramId: Number.isNaN(actorId) ? undefined : actorId,
          since:
            dayCount > 0
              ? new Date(Date.now() - dayCount * 86_400_000)
              : undefined,
          limit: AUDIT_PAGE_SIZE + 1,
          offset: Math.max(0, Number.parseInt(offset ?? '0', 10) || 0),
        }),
        deps.adminStore.listAuditActions(),
      ]);
      return {
        items: rows.slice(0, AUDIT_PAGE_SIZE).map(toAuditEntryDto),
        more: rows.length > AUDIT_PAGE_SIZE,
        actions,
      };
    },
  );

  // ── Admins ───────────────────────────────────────────────────────────────────────────────

  app.get(
    '/admins',
    { config: { permission: 'admins.manage' } },
    async (request): Promise<AdminsResponse> => {
      const admins = await deps.adminStore.listAdmins();
      const names = await adminNames(deps);
      return {
        admins: [...admins]
          .sort((a, b) => {
            if (a.isOwner !== b.isOwner) {
              return a.isOwner ? -1 : 1;
            }
            return a.telegramId - b.telegramId;
          })
          .map((admin) => {
            const by =
              admin.addedBy === null ? undefined : names.get(admin.addedBy);
            return {
              telegramId: admin.telegramId,
              isOwner: admin.isOwner,
              permissions: effectivePermissions(admin),
              username: admin.username,
              firstName: admin.firstName,
              addedBy:
                admin.addedBy === null
                  ? null
                  : formatTelegramUser(
                      admin.addedBy,
                      by?.username,
                      by?.firstName,
                    ),
              addedAt: admin.addedAt.toISOString(),
              manageable: mayManageAdmin(request.actor, admin),
            };
          }),
        catalog: [...PERMISSIONS],
        templates: [
          { id: 'moderator', permissions: [...MODERATOR_PERMISSIONS] },
          { id: 'admin', permissions: [...ADMIN_PERMISSIONS] },
        ],
        ownerGranted: [...OWNER_GRANTED_PERMISSIONS],
      };
    },
  );

  app.post(
    '/admins',
    { config: { permission: 'admins.manage', action: true } },
    async (
      request: FastifyRequest<{ Body: AddAdminRequest }>,
      reply,
    ): Promise<ActionResponse> => {
      const telegramId = request.body?.telegramId;
      if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
        throw new ApiProblem(
          400,
          'bad_request',
          'Enter their numeric Telegram ID. They can see it by opening this app.',
        );
      }
      const permissions = grantedPermissions(
        request.actor,
        [],
        permissionList(request.body?.permissions),
      );
      if (await deps.adminStore.getAdmin(telegramId)) {
        throw new ApiProblem(
          409,
          'already_admin',
          `${telegramId} is already staff.`,
        );
      }
      await deps.adminStore.addAdmin(
        telegramId,
        permissions,
        request.actor.telegramId,
      );
      await audit(request, {
        action: 'addadmin',
        target: String(telegramId),
        reason: permissions.join(','),
      });
      reply.code(201);
      return { message: `Added ${telegramId}.` };
    },
  );

  /** Someone the actor may change — refuses anyone else, and anyone who's gone. */
  async function manageableAdmin(
    request: FastifyRequest<{ Params: { id: string } }>,
  ): Promise<Admin> {
    const admin = await deps.adminStore.getAdmin(Number(request.params.id));
    if (!admin) {
      throw new ApiProblem(
        404,
        'not_found',
        "They're not on the list any more.",
      );
    }
    if (!mayManageAdmin(request.actor, admin)) {
      throw new ApiProblem(
        403,
        'forbidden',
        cannotManageReason(request.actor, admin),
      );
    }
    return admin;
  }

  app.patch(
    '/admins/:id',
    { config: { permission: 'admins.manage', action: true } },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { permissions?: string[] };
      }>,
    ): Promise<ActionResponse> => {
      const admin = await manageableAdmin(request);
      const permissions = grantedPermissions(
        request.actor,
        admin.permissions,
        permissionList(request.body?.permissions),
      );
      await deps.adminStore.setPermissions(admin.telegramId, permissions);
      await audit(request, {
        action: 'permit',
        target: String(admin.telegramId),
        reason: permissions.join(','),
      });
      return {
        message: permissions.length
          ? `Permissions set to ${permissions.join(', ')}.`
          : 'Permissions cleared.',
      };
    },
  );

  app.delete(
    '/admins/:id',
    { config: { permission: 'admins.manage', action: true } },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
    ): Promise<ActionResponse> => {
      const admin = await manageableAdmin(request);
      await deps.adminStore.removeAdmin(admin.telegramId);
      await audit(request, {
        action: 'removeadmin',
        target: String(admin.telegramId),
      });
      return { message: 'Removed from admins.' };
    },
  );

  // ── Servers ──────────────────────────────────────────────────────────────────────────────

  app.get('/servers', async (request): Promise<ServersResponse> => {
    const [configs, defaultServer] = await Promise.all([
      deps.adminStore.listServers(),
      deps.adminStore.getDefaultServer(),
    ]);
    const byAlias = new Map(configs.map((config) => [config.alias, config]));
    const showConnection = hasPermission(request.actor, 'servers.view');
    const servers = await Promise.all(
      [...deps.rconClients].map(async ([alias, rcon]) => {
        const live = await rcon.getStatus().catch(() => null);
        const config = byAlias.get(alias);
        const max = Number.parseInt(live?.cvars['sv_maxclients'] ?? '', 10);
        const hostname = live?.cvars['sv_hostname'];
        return {
          alias,
          isDefault: defaultServer?.alias === alias,
          chat: deps.logTailers.has(alias),
          online: live !== null,
          hostname: hostname ? stripColorCodes(hostname).trim() : null,
          map: live?.cvars['mapname'] ?? null,
          gametype:
            live?.cvars['g_gametype'] ?? live?.cvars['gametype'] ?? null,
          players: live?.players.length ?? 0,
          maxClients: Number.isNaN(max) ? null : max,
          ...(showConnection && config
            ? {
                connection: {
                  // The password never leaves the bot.
                  host: config.rconHost,
                  port: config.rconPort,
                  logPath: config.logSourceConfig,
                  boundChat: config.boundTelegramChatId !== null,
                  fromConfig: alias === deps.bootstrapServerAlias,
                  logFromConfig:
                    alias === deps.bootstrapServerAlias &&
                    Boolean(deps.bootstrapLogPath),
                },
              }
            : {}),
        };
      }),
    );
    return { servers };
  });

  app.post(
    '/servers',
    { config: { permission: 'servers.manage', action: true } },
    async (
      request: FastifyRequest<{ Body: AddServerRequest }>,
      reply,
    ): Promise<ActionResponse> => {
      const body = request.body ?? ({} as AddServerRequest);
      const fields = [body.alias, body.host, String(body.port), body.password];
      if (
        fields.some(
          (field) => typeof field !== 'string' || !field || /\s/.test(field),
        )
      ) {
        throw new ApiProblem(
          400,
          'bad_request',
          'Fill in the name, address, port and password — none of them can contain spaces.',
        );
      }
      const parsed = parseAddServerArgs(
        `${body.alias} ${body.host}:${body.port} ${body.password}`,
      );
      if (typeof parsed === 'string') {
        throw new ApiProblem(400, 'bad_request', parsed);
      }
      const { alias, host, port, password } = parsed;
      if (alias === deps.bootstrapServerAlias) {
        throw new ApiProblem(
          409,
          'from_config',
          `"${alias}" comes from the bot's config file, so it can't be changed here. Pick another name, or change it with install.sh --config on the bot's host.`,
        );
      }
      const checked = await checkServer(deps, { host, port, password });
      if (checked === 'no-answer') {
        throw new ApiProblem(
          422,
          'no_answer',
          `No answer from ${host}:${port}. Check the address and port, and that the server is running. Nothing was saved.`,
        );
      }
      if (checked === 'bad-password') {
        throw new ApiProblem(
          422,
          'bad_password',
          `${host}:${port} answered, but rejected the RCON password. Nothing was saved.`,
        );
      }
      const existed = deps.rconClients.has(alias);
      await saveCheckedServer(deps, parsed, checked.rcon);
      await audit(request, {
        action: existed ? 'updateserver' : 'addserver',
        target: alias,
        serverAlias: alias,
        detailJson: { host, port },
      });
      reply.code(existed ? 200 : 201);
      return {
        message: `Server "${alias}" ${existed ? 'updated' : 'added'}: ${checked.status.players.length} players on ${checked.status.mapName ?? 'an unknown map'}.`,
      };
    },
  );

  app.delete(
    '/servers/:server',
    { config: { permission: 'servers.manage', action: true } },
    async (
      request: FastifyRequest<{ Params: { server: string } }>,
    ): Promise<ActionResponse> => {
      const alias = request.params.server;
      serverParam(state, alias);
      if (alias === deps.bootstrapServerAlias) {
        throw new ApiProblem(
          409,
          'from_config',
          `"${alias}" comes from the bot's config file and would come back on the next restart, so it can't be removed here.`,
        );
      }
      await forgetServer(alias, deps);
      await audit(request, {
        action: 'removeserver',
        target: alias,
        serverAlias: alias,
      });
      return { message: `Server "${alias}" removed.` };
    },
  );

  app.post(
    '/servers/:server/default',
    { config: { permission: 'servers.assign', action: true } },
    async (
      request: FastifyRequest<{ Params: { server: string } }>,
    ): Promise<ActionResponse> => {
      const alias = request.params.server;
      serverParam(state, alias);
      await deps.adminStore.setDefaultServer(alias);
      await audit(request, {
        action: 'setdefault',
        target: alias,
        serverAlias: alias,
      });
      return { message: `"${alias}" is now the default server.` };
    },
  );

  app.post(
    '/servers/:server/log',
    { config: { permission: 'servers.manage', action: true } },
    async (
      request: FastifyRequest<{
        Params: { server: string };
        Body: LogRequest;
      }>,
    ): Promise<LogResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const { startTailer, decode } = state.integrations;
      if (!startTailer || !decode) {
        throw new ApiProblem(
          503,
          'unavailable',
          "This can't be done right now.",
        );
      }
      if (alias === deps.bootstrapServerAlias && deps.bootstrapLogPath) {
        throw new ApiProblem(
          409,
          'from_config',
          "This server's log is set in the bot's config file. To manage it here, remove COD2_LOG_PATH from .env and restart the bot.",
        );
      }
      const current =
        (await deps.adminStore.getServer(alias))?.logSourceConfig ?? null;
      const unchanged = (
        message: string,
        possible: string[] = [],
      ): LogResponse => ({
        logPath: current,
        changed: false,
        message,
        possible,
      });
      const save = async (path: string | null): Promise<LogResponse> => {
        await deps.adminStore.setServerLogPath(alias, path);
        stopReportTailer(alias, deps);
        const server = path
          ? await deps.adminStore.getServer(alias)
          : undefined;
        if (server) {
          startTailer(server);
        }
        await audit(request, {
          action: 'setlogpath',
          target: path,
          serverAlias: alias,
        });
        return {
          logPath: path,
          changed: true,
          message: path
            ? `Now reading ${path}.`
            : `Stopped reading the log of "${alias}".`,
          possible: [],
        };
      };

      const body = request.body;
      if (body?.action === 'off') {
        return save(null);
      }
      if (body?.action === 'set') {
        const path = typeof body.path === 'string' ? body.path.trim() : '';
        if (!path.startsWith('/')) {
          throw new ApiProblem(
            400,
            'bad_request',
            'Enter a full path, starting with /.',
          );
        }
        const live = await readLiveServerInfo(rcon);
        const verdict = await inspectLogFile(path, live, decode);
        if (verdict === 'current' || verdict === 'same-name') {
          return save(path);
        }
        return unchanged(
          verdict === 'unreadable'
            ? unreadableLogHelp([path], detectBotRuntime())
            : describeLogProblem(alias, verdict),
        );
      }
      if (body?.action === 'search') {
        const result = await findGameLog(rcon, { decode });
        return result.log
          ? save(result.log)
          : unchanged(
              describeLogSearchFailure(alias, result).join('\n\n'),
              result.possible,
            );
      }
      throw new ApiProblem(400, 'bad_request', 'Unknown action.');
    },
  );

  // ── Server settings ──────────────────────────────────────────────────────────────────────

  app.get(
    '/servers/:server/cvars',
    { config: { permission: 'cvars.read' } },
    async (
      request: FastifyRequest<{ Params: { server: string } }>,
    ): Promise<CvarsResponse> => {
      const { cvars } = await serverParam(
        state,
        request.params.server,
      ).getStatus();
      return {
        cvars: Object.entries(cvars)
          .map(([name, value]) => ({ name, value }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
  );

  app.post(
    '/servers/:server/cvars',
    { config: { permission: 'cvars.write', action: true } },
    async (
      request: FastifyRequest<{
        Params: { server: string };
        Body: SetCvarRequest;
      }>,
    ): Promise<ActionResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const name =
        typeof request.body?.name === 'string' ? request.body.name.trim() : '';
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
        throw new ApiProblem(
          400,
          'bad_request',
          "That's not a valid setting name.",
        );
      }
      if (CVARS_NOT_FROM_HERE.has(name.toLowerCase())) {
        throw new ApiProblem(
          400,
          'bad_request',
          "Changing the RCON password from here would cut the bot off from this server. Change it in the server's config, then update the server here.",
        );
      }
      const value =
        typeof request.body?.value === 'string'
          ? sanitizeRconArg(request.body.value).slice(0, 512)
          : '';
      await rcon.setCvar(name, value);
      await audit(request, {
        action: 'setcvar',
        target: name,
        serverAlias: alias,
        detailJson: { value },
      });
      return {
        message: `${name} set. A server restart can undo it unless it's in the config too.`,
      };
    },
  );

  // ── Presets ──────────────────────────────────────────────────────────────────────────────

  app.get('/presets', async (): Promise<Presets> => {
    const stored = await deps.adminStore.getSetting(PRESETS_SETTING_KEY);
    return stored === undefined ? DEFAULT_PRESETS : parsePresets(stored);
  });

  app.put(
    '/presets',
    { config: { permission: 'presets', action: true } },
    async (request: FastifyRequest<{ Body: Presets }>): Promise<Presets> => {
      const presets = parsePresets(request.body);
      await deps.adminStore.setSetting(PRESETS_SETTING_KEY, presets);
      await audit(request, { action: 'presets', detailJson: presets });
      return presets;
    },
  );

  // ── VPN rules (/vpnkick, /vpnnets) ───────────────────────────────────────────────────────

  const vpnResponse = async (): Promise<VpnResponse> => {
    const { enabled, exempt } = deps.vpnKick.settings;
    const networks = parseVpnNetworks(
      await deps.adminStore.getSetting(VPN_NETWORKS_SETTING_KEY),
    );
    return {
      flagsEnabled: deps.vpn !== NO_VPN_LOOKUP,
      kickEnabled: enabled,
      exempt,
      networks: networks.map(({ asn, name }) => ({ asn, name: name ?? null })),
    };
  };

  const saveKick = async (
    request: FastifyRequest,
    settings: { enabled: boolean; exempt: string[] },
    detailJson: unknown,
  ) => {
    await deps.adminStore.setSetting(VPN_KICK_SETTING_KEY, settings);
    deps.vpnKick.setSettings(settings);
    await audit(request, { action: 'vpnkick', detailJson });
  };

  const saveNetworks = async (
    request: FastifyRequest,
    networks: VpnNetwork[],
    detailJson: unknown,
  ) => {
    await deps.adminStore.setSetting(VPN_NETWORKS_SETTING_KEY, networks);
    deps.vpn.setNetworks(networks.map((network) => network.asn));
    await audit(request, { action: 'vpnnets', detailJson });
  };

  app.get('/vpn', { config: { permission: 'vpn' } }, vpnResponse);

  app.put(
    '/vpn/kick',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{ Body: { enabled?: boolean } }>,
    ): Promise<VpnResponse> => {
      if (typeof request.body?.enabled !== 'boolean') {
        throw new ApiProblem(400, 'bad_request', 'On or off?');
      }
      const enabled = request.body.enabled;
      await saveKick(
        request,
        { ...deps.vpnKick.settings, enabled },
        { enabled },
      );
      return vpnResponse();
    },
  );

  const exemptEntry = (value: unknown): string => {
    const entry = typeof value === 'string' ? normalizeExempt(value) : '';
    if (!entry) {
      throw new ApiProblem(400, 'bad_request', 'Enter a GUID or a name.');
    }
    return entry;
  };

  app.post(
    '/vpn/exempt',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{ Body: { player?: string } }>,
    ): Promise<VpnResponse> => {
      const entry = exemptEntry(request.body?.player);
      const settings = deps.vpnKick.settings;
      if (settings.exempt.includes(entry)) {
        throw new ApiProblem(409, 'already', `${entry} is already exempt.`);
      }
      await saveKick(
        request,
        { ...settings, exempt: [...settings.exempt, entry] },
        { allow: entry },
      );
      return vpnResponse();
    },
  );

  app.post(
    '/vpn/exempt/remove',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{ Body: { player?: string } }>,
    ): Promise<VpnResponse> => {
      const entry = exemptEntry(request.body?.player);
      const settings = deps.vpnKick.settings;
      await saveKick(
        request,
        {
          ...settings,
          exempt: settings.exempt.filter((existing) => existing !== entry),
        },
        { unallow: entry },
      );
      return vpnResponse();
    },
  );

  app.post(
    '/vpn/networks',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{ Body: { value?: string } }>,
    ): Promise<VpnResponse> => {
      const value =
        typeof request.body?.value === 'string'
          ? request.body.value.trim()
          : '';
      let network: VpnNetwork | undefined;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
        const asn = deps.provider.asn(value);
        if (asn === undefined) {
          throw new ApiProblem(
            422,
            'unknown_network',
            `Couldn't find the provider network for ${value}. Add it by ASN instead, e.g. AS202226.`,
          );
        }
        const name = deps.provider.lookup(value);
        network = name ? { asn, name } : { asn };
      } else {
        const asn = parseAsn(value);
        network = asn === undefined ? undefined : { asn };
      }
      if (!network) {
        throw new ApiProblem(
          400,
          'bad_request',
          'Enter a player IP or an ASN, like AS202226.',
        );
      }
      const added = network;
      const networks = parseVpnNetworks(
        await deps.adminStore.getSetting(VPN_NETWORKS_SETTING_KEY),
      );
      if (networks.some((existing) => existing.asn === added.asn)) {
        throw new ApiProblem(
          409,
          'already',
          `AS${added.asn} is already marked as VPN.`,
        );
      }
      await saveNetworks(request, [...networks, added], { add: added.asn });
      return vpnResponse();
    },
  );

  app.delete(
    '/vpn/networks/:asn',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{ Params: { asn: string } }>,
    ): Promise<VpnResponse> => {
      const asn = Number(request.params.asn);
      const networks = parseVpnNetworks(
        await deps.adminStore.getSetting(VPN_NETWORKS_SETTING_KEY),
      );
      await saveNetworks(
        request,
        networks.filter((network) => network.asn !== asn),
        { remove: asn },
      );
      return vpnResponse();
    },
  );

  // ── Known players (/known) ───────────────────────────────────────────────────────────────

  const knownResponse = (): KnownResponse => ({
    enabled: deps.knownPlayers.enabled,
    entries: deps.knownPlayers.entries.map(({ name, display, asns, guids, note }) => ({
      name,
      display,
      asns,
      guids,
      note,
    })),
  });

  const reloadKnown = async () =>
    deps.knownPlayers.setEntries(await deps.adminStore.listKnownPlayers());

  const knownEntry = (value: unknown) => {
    const name = typeof value === 'string' ? normalizeKnownName(value) : '';
    const entry = deps.knownPlayers.entries.find((e) => e.name === name);
    if (!entry) {
      throw new ApiProblem(404, 'not_found', 'No such known player.');
    }
    return entry;
  };

  /** A player IP (→ its provider network), an ASN like `AS12389`, or `guid:716922`. */
  const identityFromInput = (
    value: unknown,
  ): { asn: number } | { guid: string } => {
    const text = typeof value === 'string' ? value.trim() : '';
    const guid = /^guid:?\s*(\d{1,20})$/i.exec(text)?.[1];
    if (guid && guid !== '0') {
      return { guid };
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
      const asn = deps.provider.asn(text);
      if (asn === undefined) {
        throw new ApiProblem(
          422,
          'unknown_network',
          `Couldn't find the provider network for ${text}. Use an ASN instead, e.g. AS12389.`,
        );
      }
      return { asn };
    }
    const asn = parseAsn(text);
    if (asn === undefined) {
      throw new ApiProblem(
        400,
        'bad_request',
        'Enter a player IP, an ASN like AS12389, or a GUID like guid:716922.',
      );
    }
    return { asn };
  };

  const saveKnown = async (
    request: FastifyRequest,
    entry: {
      name: string;
      display: string;
      asns: number[];
      guids: string[];
      note: string | null;
    },
    action: string,
    detailJson: unknown,
  ): Promise<KnownResponse> => {
    await deps.adminStore.saveKnownPlayer({
      ...entry,
      createdBy: request.actor.telegramId,
    });
    await reloadKnown();
    await audit(request, { action, target: entry.name, detailJson });
    return knownResponse();
  };

  app.get('/known', { config: { permission: 'vpn' } }, knownResponse);

  app.put(
    '/known/enabled',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{ Body: { enabled?: boolean } }>,
    ): Promise<KnownResponse> => {
      if (typeof request.body?.enabled !== 'boolean') {
        throw new ApiProblem(400, 'bad_request', 'On or off?');
      }
      const enabled = request.body.enabled;
      await deps.adminStore.setSetting(KNOWN_PLAYERS_SETTING_KEY, { enabled });
      deps.knownPlayers.setEnabled(enabled);
      await audit(request, { action: 'known', detailJson: { enabled } });
      return knownResponse();
    },
  );

  /** Adds a name with its first network, or one more network for a name already listed. */
  app.post(
    '/known',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{ Body: { name?: string; value?: string } }>,
    ): Promise<KnownResponse> => {
      const display =
        typeof request.body?.name === 'string' ? request.body.name.trim() : '';
      const name = display ? normalizeKnownName(display) : '';
      if (!name) {
        throw new ApiProblem(400, 'bad_request', 'Enter a nickname.');
      }
      const identity = identityFromInput(request.body?.value);
      const existing = deps.knownPlayers.entries.find((e) => e.name === name);
      const asns = existing?.asns ?? [];
      const guids = existing?.guids ?? [];
      if (
        'asn' in identity
          ? asns.includes(identity.asn)
          : guids.includes(identity.guid)
      ) {
        throw new ApiProblem(
          409,
          'already',
          `${existing!.display} already has ${'asn' in identity ? `AS${identity.asn}` : `GUID ${identity.guid}`}.`,
        );
      }
      return saveKnown(
        request,
        {
          name,
          display: existing?.display ?? display,
          asns: 'asn' in identity ? [...asns, identity.asn] : asns,
          guids: 'guid' in identity ? [...guids, identity.guid] : guids,
          note: existing?.note ?? null,
        },
        'known_add',
        identity,
      );
    },
  );

  app.post(
    '/known/asn/remove',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{ Body: { name?: string; asn?: number } }>,
    ): Promise<KnownResponse> => {
      const entry = knownEntry(request.body?.name);
      const asn = request.body?.asn;
      if (typeof asn !== 'number' || !entry.asns.includes(asn)) {
        throw new ApiProblem(404, 'not_found', 'No such network on this player.');
      }
      if (entry.asns.length + entry.guids.length === 1) {
        throw new ApiProblem(
          409,
          'last_network',
          'That is the last network or GUID — remove the player instead.',
        );
      }
      return saveKnown(
        request,
        { ...entry, asns: entry.asns.filter((a) => a !== asn) },
        'known_asn_remove',
        { asn },
      );
    },
  );

  app.post(
    '/known/guid/remove',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{ Body: { name?: string; guid?: string } }>,
    ): Promise<KnownResponse> => {
      const entry = knownEntry(request.body?.name);
      const guid = request.body?.guid;
      if (typeof guid !== 'string' || !entry.guids.includes(guid)) {
        throw new ApiProblem(404, 'not_found', 'No such GUID on this player.');
      }
      if (entry.asns.length + entry.guids.length === 1) {
        throw new ApiProblem(
          409,
          'last_network',
          'That is the last network or GUID — remove the player instead.',
        );
      }
      return saveKnown(
        request,
        { ...entry, guids: entry.guids.filter((g) => g !== guid) },
        'known_guid_remove',
        { guid },
      );
    },
  );

  app.post(
    '/known/note',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{ Body: { name?: string; note?: string } }>,
    ): Promise<KnownResponse> => {
      const entry = knownEntry(request.body?.name);
      const note =
        typeof request.body?.note === 'string'
          ? request.body.note.trim().slice(0, 200) || null
          : null;
      return saveKnown(request, { ...entry, note }, 'known_note', { note });
    },
  );

  app.post(
    '/known/remove',
    { config: { permission: 'vpn', action: true } },
    async (
      request: FastifyRequest<{ Body: { name?: string } }>,
    ): Promise<KnownResponse> => {
      const entry = knownEntry(request.body?.name);
      await deps.adminStore.deleteKnownPlayer(entry.name);
      await reloadKnown();
      await audit(request, {
        action: 'known_remove',
        target: entry.name,
        detailJson: { asns: entry.asns },
      });
      return knownResponse();
    },
  );

  // ── Telegram routes (/relays, owner) ─────────────────────────────────────────────────────

  const relaysResponse = async (): Promise<RelaysResponse> => {
    const { settings, changed } = await loadRouteSettings(deps);
    const { router } = deps.telegramRoutes;
    return {
      current: router.current,
      direct: settings.direct,
      relays: settings.relays,
      routes: routesFrom(settings).map((url) => ({
        url,
        label: describeRoute(url),
        inUse: url === router.current,
      })),
      changed,
    };
  };

  const saveRoutes = async (
    request: FastifyRequest,
    settings: TelegramRouteSettings,
    detailJson: unknown,
  ) => {
    await deps.adminStore.setSetting(ROUTES_SETTING_KEY, settings);
    deps.telegramRoutes.router.setRoutes(routesFrom(settings));
    await audit(request, { action: 'relays', detailJson });
  };

  app.get('/relays', { config: { permission: 'relays' } }, relaysResponse);

  app.post(
    '/relays/test',
    { config: { permission: 'relays', action: true } },
    async (): Promise<RelayTestResponse> => {
      const { settings } = await loadRouteSettings(deps);
      const routes = routesFrom(settings);
      const results = await Promise.all(
        routes.map((root) => deps.telegramRoutes.probe(root)),
      );
      return {
        results: routes.map((url, index) => {
          const result = results[index]!;
          return {
            url,
            label: describeRoute(url),
            ok: result.ok,
            ...(result.ok ? { ms: result.ms } : { error: result.error }),
          };
        }),
      };
    },
  );

  app.post(
    '/relays',
    { config: { permission: 'relays', action: true } },
    async (
      request: FastifyRequest<{ Body: { url?: string } }>,
    ): Promise<RelaysResponse> => {
      const url =
        typeof request.body?.url === 'string'
          ? normalizeRelayUrl(request.body.url)
          : undefined;
      if (!url) {
        throw new ApiProblem(
          400,
          'bad_request',
          'Enter an https address, like https://my-relay.deno.dev',
        );
      }
      const { settings } = await loadRouteSettings(deps);
      if (url === DIRECT_TELEGRAM_ROOT || settings.relays.includes(url)) {
        throw new ApiProblem(409, 'already', `${url} is already in the list.`);
      }
      const probe = await deps.telegramRoutes.probe(url);
      if (!probe.ok) {
        throw new ApiProblem(
          422,
          'relay_unreachable',
          `Couldn't reach Telegram through ${url} (${probe.error}). Nothing was changed.`,
        );
      }
      await saveRoutes(
        request,
        { ...settings, relays: [...settings.relays, url] },
        { add: url },
      );
      return relaysResponse();
    },
  );

  app.post(
    '/relays/remove',
    { config: { permission: 'relays', action: true } },
    async (
      request: FastifyRequest<{ Body: { url?: string } }>,
    ): Promise<RelaysResponse> => {
      const { settings } = await loadRouteSettings(deps);
      const target = request.body?.url;
      const next = {
        ...settings,
        relays: settings.relays.filter((relay) => relay !== target),
      };
      if (routesFrom(next).length === 0) {
        throw new ApiProblem(
          409,
          'last_route',
          "That's the only route left — add another one first.",
        );
      }
      await saveRoutes(request, next, { remove: target });
      return relaysResponse();
    },
  );

  app.put(
    '/relays/direct',
    { config: { permission: 'relays', action: true } },
    async (
      request: FastifyRequest<{ Body: { direct?: boolean } }>,
    ): Promise<RelaysResponse> => {
      if (typeof request.body?.direct !== 'boolean') {
        throw new ApiProblem(400, 'bad_request', 'On or off?');
      }
      const { settings } = await loadRouteSettings(deps);
      const next = { ...settings, direct: request.body.direct };
      if (routesFrom(next).length === 0) {
        throw new ApiProblem(
          409,
          'last_route',
          'There are no relays — add one before turning direct access off.',
        );
      }
      await saveRoutes(request, next, { direct: next.direct });
      return relaysResponse();
    },
  );

  app.post(
    '/relays/reset',
    { config: { permission: 'relays', action: true } },
    async (request): Promise<RelaysResponse> => {
      await deps.adminStore.deleteSetting(ROUTES_SETTING_KEY);
      deps.telegramRoutes.router.setRoutes(
        routesFrom(deps.telegramRoutes.defaults),
      );
      await audit(request, { action: 'relays', detailJson: { reset: true } });
      return relaysResponse();
    },
  );

  // ── Game-chat lines (/templates) ─────────────────────────────────────────────────────────

  const templatesResponse = (): ChatTemplatesResponse => ({
    lines: chatTemplateLines(deps.chatTemplates.all),
  });

  app.get(
    '/templates',
    { config: { permission: 'templates' } },
    templatesResponse,
  );

  app.put(
    '/templates',
    { config: { permission: 'templates', action: true } },
    async (
      request: FastifyRequest<{ Body: ChatTemplatesUpdate }>,
    ): Promise<ChatTemplatesResponse> => {
      const texts = request.body?.texts;
      if (typeof texts !== 'object' || texts === null) {
        throw new ApiProblem(400, 'bad_request', 'Which lines?');
      }
      for (const value of Object.values(texts)) {
        if (typeof value !== 'string') {
          throw new ApiProblem(400, 'bad_request', 'Each line is text.');
        }
      }
      const next = applyChatTemplates(deps.chatTemplates.all, texts);
      await deps.adminStore.setSetting(CHAT_TEMPLATES_SETTING_KEY, next);
      deps.chatTemplates.setAll(next);
      await audit(request, { action: 'templates', detailJson: next });
      return templatesResponse();
    },
  );

  // ── Self-update (/update, owner) ─────────────────────────────────────────────────────────

  app.get(
    '/update',
    { config: { permission: 'update' } },
    async (): Promise<UpdateStatusResponse> => {
      const running = getRunningVersion();
      const base = {
        enabled: Boolean(deps.updateConfig),
        running,
        problem: state.updateProblem,
      };
      try {
        const release = await deps.githubReleaseClient.getLatestRelease();
        return {
          ...base,
          latest: release.tagName,
          notes: release.notes || null,
          available: isNewerVersion(release.tagName, running),
          checkError: null,
        };
      } catch (error) {
        return {
          ...base,
          latest: null,
          notes: null,
          available: false,
          checkError: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  app.post(
    '/update',
    { config: { permission: 'update', action: true } },
    async (
      request: FastifyRequest<{ Body: ApplyUpdateRequest }>,
    ): Promise<ActionResponse> => {
      const config = deps.updateConfig;
      if (!config) {
        throw new ApiProblem(
          409,
          'update_disabled',
          "Self-update isn't available on this install — re-run install.sh to enable it.",
        );
      }
      const release = await deps.githubReleaseClient.getLatestRelease();
      if (release.tagName !== request.body?.tag) {
        throw new ApiProblem(
          409,
          'release_changed',
          `The latest version is ${release.tagName} now. Look it over and try again.`,
        );
      }
      if (!isNewerVersion(release.tagName, getRunningVersion())) {
        throw new ApiProblem(409, 'up_to_date', 'Already up to date.');
      }
      state.updateProblem = null;
      // The new version reports to this private chat with the bot (update-boot-check.ts).
      const staged = await stageRelease(
        release,
        config,
        request.actor.telegramId,
      );
      if (!staged.ok) {
        throw new ApiProblem(502, 'update_failed', staged.message);
      }
      await audit(request, {
        action: 'update',
        target: release.tagName,
        detailJson: {
          tagName: release.tagName,
          assetName: release.gatewayAsset.name,
        },
      });
      runApplyUpdate(config.applyUpdateScriptPath, staged.tarballPath, {
        onProblem: (problem) => {
          void settleApplyProblem(problem, {
            tagName: release.tagName,
            command: `${config.applyUpdateScriptPath} ${staged.tarballPath}`,
            markerPath: staged.markerPath,
          }).then((text) => {
            state.updateProblem = text;
          });
        },
      });
      return {
        message: `Applying ${release.tagName}… the bot restarts shortly and rolls back by itself if the new version fails to start.`,
      };
    },
  );
}
