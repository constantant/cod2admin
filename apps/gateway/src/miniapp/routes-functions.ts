import type { CustomFunction, Permission } from '@cod2admin/admin-store';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  FunctionError,
  MAX_FUNCTIONS,
  needsContext,
  parseFunctionInput,
  resolveSetting,
  resolveSteps,
  type ResolveContext,
} from '../lib/custom-functions.js';
import type { GatewayDeps } from '../lib/deps.js';
import { ApiProblem } from './api-problem.js';
import type {
  CustomFunctionDto,
  FunctionsResponse,
  PreviewFunctionRequest,
  PreviewFunctionResponse,
  RunFunctionRequest,
  RunFunctionResponse,
  SaveFunctionRequest,
} from './api-types.js';
import { hasPermission } from './auth.js';
import { serverParam } from './routes.js';
import type { MiniAppState } from './state.js';

export function toFunctionDto(fn: CustomFunction): CustomFunctionDto {
  return {
    id: fn.id,
    slug: fn.slug,
    title: fn.title,
    description: fn.description,
    icon: fn.icon,
    kind: fn.kind,
    definition: fn.definition,
    serverAlias: fn.serverAlias,
    requires: fn.requires as Permission | null,
    dangerous: fn.dangerous,
    enabled: fn.enabled,
    createdBy: fn.createdBy,
    createdAt: fn.createdAt.toISOString(),
    updatedAt: fn.updatedAt.toISOString(),
  };
}

/** A problem in what the owner or caller sent becomes a 400 with the reason. */
function badRequest<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof FunctionError) {
      throw new ApiProblem(400, 'bad_request', error.message);
    }
    throw error;
  }
}

function functionId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw new ApiProblem(404, 'not_found', 'There is no such function.');
  }
  return id;
}

/**
 * Custom functions (docs/PLAN-custom-functions.md): the owner defines RCON command templates and
 * cvar settings, staff run them. Defining is as powerful as the raw console, so
 * `functions.manage` is owner-granted (`OWNER_GRANTED_PERMISSIONS`); running needs
 * `functions.run` plus whatever the function itself requires. The client never sends command text:
 * a run names a function and its values, and the commands are built here.
 */
export function registerFunctionRoutes(
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
      detailJson?: unknown;
    },
  ) =>
    deps.adminStore.recordAuditLog({
      actorTelegramId: request.actor.telegramId,
      source: 'miniapp',
      ...entry,
    });

  /** The live data a definition's player and map parameters are checked against. */
  async function contextFor(
    alias: string,
    fn: Pick<CustomFunction, 'kind' | 'definition'>,
  ): Promise<ResolveContext> {
    const needs = needsContext(fn);
    const rcon = needs.players || needs.maps ? serverParam(state, alias) : null;
    return {
      players: needs.players ? (await rcon?.status())?.players : undefined,
      maps: needs.maps ? await rcon?.getInstalledMaps() : undefined,
    };
  }

  async function ownedBy(id: number): Promise<CustomFunction> {
    const fn = await deps.adminStore.getCustomFunction(id);
    if (!fn) {
      throw new ApiProblem(404, 'not_found', 'There is no such function.');
    }
    return fn;
  }

  // ── Defining (functions.manage) ──────────────────────────────────────────────────────────

  app.get(
    '/functions',
    { config: { permission: 'functions.manage' } },
    async (): Promise<FunctionsResponse> => ({
      functions: (await deps.adminStore.listCustomFunctions()).map(
        toFunctionDto,
      ),
    }),
  );

  app.post(
    '/functions',
    { config: { permission: 'functions.manage', action: true } },
    async (
      request: FastifyRequest<{ Body: SaveFunctionRequest }>,
    ): Promise<CustomFunctionDto> => {
      const input = badRequest(() => parseFunctionInput(request.body));
      const existing = await deps.adminStore.listCustomFunctions();
      if (existing.length >= MAX_FUNCTIONS) {
        throw new ApiProblem(
          400,
          'bad_request',
          `That's the limit: ${MAX_FUNCTIONS} functions.`,
        );
      }
      const created = await deps.adminStore.createCustomFunction({
        ...input,
        createdBy: request.actor.telegramId,
      });
      if (!created) {
        throw new ApiProblem(
          409,
          'conflict',
          `There's already a function with the id "${input.slug}".`,
        );
      }
      await audit(request, {
        action: 'functioncreate',
        target: created.slug,
        serverAlias: created.serverAlias,
        detailJson: { definition: created.definition, kind: created.kind },
      });
      return toFunctionDto(created);
    },
  );

  app.put(
    '/functions/:id',
    { config: { permission: 'functions.manage', action: true } },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: SaveFunctionRequest;
      }>,
    ): Promise<CustomFunctionDto> => {
      const current = await ownedBy(functionId(request.params.id));
      const { slug, ...input } = badRequest(() =>
        parseFunctionInput(request.body),
      );
      if (slug !== current.slug) {
        throw new ApiProblem(
          400,
          'bad_request',
          "The id can't change; make a new function instead.",
        );
      }
      const updated = await deps.adminStore.updateCustomFunction(
        current.id,
        input,
      );
      if (!updated) {
        throw new ApiProblem(404, 'not_found', 'There is no such function.');
      }
      await audit(request, {
        action: 'functionupdate',
        target: updated.slug,
        serverAlias: updated.serverAlias,
        detailJson: { definition: updated.definition, kind: updated.kind },
      });
      return toFunctionDto(updated);
    },
  );

  app.delete(
    '/functions/:id',
    { config: { permission: 'functions.manage', action: true } },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
    ): Promise<{ message: string }> => {
      const current = await ownedBy(functionId(request.params.id));
      await deps.adminStore.deleteCustomFunction(current.id);
      await audit(request, {
        action: 'functiondelete',
        target: current.slug,
        serverAlias: current.serverAlias,
      });
      return { message: `${current.title} deleted.` };
    },
  );

  /** What a draft would send, without sending it — for the editor's live preview. */
  app.post(
    '/functions/preview',
    { config: { permission: 'functions.manage' } },
    async (
      request: FastifyRequest<{ Body: PreviewFunctionRequest }>,
    ): Promise<PreviewFunctionResponse> => {
      const draft = badRequest(() =>
        parseFunctionInput(request.body?.function),
      );
      const server = request.body?.server;
      const context: ResolveContext = server
        ? await contextFor(server, draft)
        : {};
      return badRequest(() => {
        if ('cvar' in draft.definition) {
          const { cvar, value } = resolveSetting(draft, request.body?.value);
          return { commands: [`set ${cvar} "${value}"`] };
        }
        return {
          commands: resolveSteps(draft, request.body?.values, context),
        };
      });
    },
  );

  // ── Running (functions.run) ──────────────────────────────────────────────────────────────

  /** What applies to this server and the caller may run. */
  app.get(
    '/servers/:server/functions',
    { config: { permission: 'functions.run' } },
    async (
      request: FastifyRequest<{ Params: { server: string } }>,
    ): Promise<FunctionsResponse> => {
      const alias = request.params.server;
      serverParam(state, alias);
      const all = await deps.adminStore.listCustomFunctions();
      return {
        functions: all
          .filter(
            (fn) =>
              fn.enabled &&
              (fn.serverAlias === null || fn.serverAlias === alias) &&
              (!fn.requires ||
                hasPermission(request.actor, fn.requires as Permission)),
          )
          .map(toFunctionDto),
      };
    },
  );

  app.post(
    '/servers/:server/functions/:id/run',
    { config: { permission: 'functions.run', action: true } },
    async (
      request: FastifyRequest<{
        Params: { server: string; id: string };
        Body: RunFunctionRequest;
      }>,
    ): Promise<RunFunctionResponse> => {
      const alias = request.params.server;
      const rcon = serverParam(state, alias);
      const fn = await ownedBy(functionId(request.params.id));
      // Same answer for "hidden from you" as for "doesn't exist", so ids don't leak.
      const hidden =
        !fn.enabled ||
        (fn.serverAlias !== null && fn.serverAlias !== alias) ||
        (fn.requires !== null &&
          !hasPermission(request.actor, fn.requires as Permission));
      if (hidden) {
        throw new ApiProblem(404, 'not_found', 'There is no such function.');
      }
      if (fn.dangerous && request.body?.confirm !== true) {
        throw new ApiProblem(
          400,
          'confirm_required',
          `${fn.title} needs a confirmation.`,
        );
      }

      const steps: RunFunctionResponse['steps'] = [];
      const context = await contextFor(alias, fn);
      const commands = badRequest(() => {
        if (fn.kind === 'setting') {
          const { cvar, value } = resolveSetting(fn, request.body?.value);
          return [{ cvar, value }];
        }
        return resolveSteps(fn, request.body?.values, context).map(
          (command) => ({ command }),
        );
      });

      try {
        for (const entry of commands) {
          if ('cvar' in entry) {
            await rcon.setCvar(entry.cvar, entry.value);
            steps.push({
              command: `set ${entry.cvar} "${entry.value}"`,
              output: '',
            });
          } else {
            steps.push({
              command: entry.command,
              output: (await rcon.rcon(entry.command)).trim(),
            });
          }
        }
      } finally {
        // Also when a later step fails: what already reached the server stays on the record.
        await audit(request, {
          action: 'functionrun',
          target: fn.slug,
          serverAlias: alias,
          detailJson: {
            commands: steps.map((step) => step.command),
            planned: commands.length,
          },
        });
      }
      return { message: `${fn.title}: done.`, steps };
    },
  );
}
