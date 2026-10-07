import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { UdpQueryTimeoutError } from '@cod2admin/rcon-client';
import Fastify, { type FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { SERVER_UNRESPONSIVE_MESSAGE } from '../lib/bot.js';
import type { GatewayDeps } from '../lib/deps.js';
import { ModerationActionError } from '../lib/moderation-actions.js';
import type { LiveClientMessage, LiveServerMessage } from './api-types.js';
import {
  authenticate,
  hasRole,
  initDataFromHeader,
  type AuthOptions,
  type MiniAppActor,
} from './auth.js';
import { ApiProblem, apiError, registerRoutes } from './routes.js';
import { MiniAppState } from './state.js';

export interface MiniAppServerOptions {
  botToken: string;
  /** The built `apps/miniapp-web` — served at `/` when it has an `index.html`. */
  staticDir?: string;
  devTelegramId?: number;
}

/** How long a new WebSocket has to send its `auth` message. */
const WS_AUTH_TIMEOUT_MS = 10_000;

/**
 * Angular's build puts a content hash in every script and stylesheet name (`main-TUNT5KH7.js`,
 * `chunk-De-zqpfv.js`) — those files never change, unlike `index.html`.
 */
const HASHED_ASSET =
  /(?:^|[\\/])(?:main|chunk|polyfills|styles)-[\w-]{8}\.(?:js|css)$/;

/**
 * The Mini App's backend (docs/PLAN-miniapp.md §3.1): a module of the gateway process, so it uses
 * the bot's own RCON clients, stores and log tailers instead of a second copy of each. Serves
 * `/api/*` (routes.ts), the live `/api/ws` feed, and the web app itself.
 */
export async function createMiniAppServer(
  deps: GatewayDeps,
  options: MiniAppServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const state = new MiniAppState(deps);
  const authOptions: AuthOptions = {
    botToken: options.botToken,
    adminStore: deps.adminStore,
    devTelegramId: options.devTelegramId,
  };

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiProblem) {
      return reply.code(error.status).send(apiError(error.code, error.message));
    }
    if (error instanceof UdpQueryTimeoutError) {
      return reply
        .code(504)
        .send(apiError('server_unresponsive', SERVER_UNRESPONSIVE_MESSAGE));
    }
    if (error instanceof ModerationActionError) {
      return reply.code(422).send(apiError('cannot_moderate', error.message));
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send(apiError('bad_request', (error as Error).message));
    }
    console.error(`Mini App: ${request.method} ${request.url} failed:`, error);
    return reply
      .code(500)
      .send(
        apiError('internal', 'Something went wrong on the bot. Check its log.'),
      );
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });

  await app.register(
    async (api) => {
      api.decorateRequest('actor', null as unknown as MiniAppActor);
      api.addHook('preHandler', async (request, reply) => {
        if (request.routeOptions.config.websocket) {
          return; // authenticates with its first message — browsers can't set headers on a WebSocket
        }
        const outcome = await authenticate(
          initDataFromHeader(request.headers.authorization),
          authOptions,
        );
        if (!outcome.ok) {
          return reply
            .code(outcome.status)
            .send(apiError(outcome.error, outcome.message));
        }
        request.actor = outcome.actor;
        const { minRole, action } = request.routeOptions.config;
        if (minRole && !hasRole(outcome.actor, minRole)) {
          return reply
            .code(403)
            .send(
              apiError(
                'forbidden',
                `This needs the ${minRole} role — you're ${outcome.actor.role}.`,
              ),
            );
        }
        if (action && !state.limiter.take(outcome.actor.telegramId)) {
          return reply
            .code(429)
            .send(
              apiError(
                'slow_down',
                'Too many actions at once — wait a few seconds.',
              ),
            );
        }
      });
      registerRoutes(api, deps, state);
      api.get(
        '/ws',
        { websocket: true, config: { websocket: true } },
        (socket) => {
          handleLiveSocket(socket, state, authOptions);
        },
      );
      api.all('/*', async (_request, reply) =>
        reply.code(404).send(apiError('not_found', 'No such API route.')),
      );
    },
    { prefix: '/api' },
  );

  const staticDir = options.staticDir;
  if (staticDir && existsSync(path.join(staticDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: staticDir,
      setHeaders: (reply, filePath) => {
        reply.header(
          'Cache-Control',
          HASHED_ASSET.test(filePath)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    });
    // The app's own routes (/players, /bans, …) all load index.html; Angular's router takes it from there.
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method !== 'GET' ||
        path.extname(request.url.split('?')[0]!)
      ) {
        return reply.code(404).send('Not found');
      }
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.get(
      '/',
      async () =>
        'cod2admin Mini App API is running, but the web app was not found next to the bot.',
    );
  }

  return app;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    websocket?: boolean;
  }
}

/**
 * `/api/ws`: the first message authenticates (`initData`, same checks as the REST API), then
 * `subscribe` picks a server and the socket gets its live status and chat lines until it
 * subscribes elsewhere or closes.
 */
function handleLiveSocket(
  socket: WebSocket,
  state: MiniAppState,
  authOptions: AuthOptions,
): void {
  let actor: MiniAppActor | undefined;
  let unsubscribe: (() => void)[] = [];
  const send = (message: LiveServerMessage) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };
  const fail = (error: string, message: string) => {
    send({ type: 'error', error, message });
    socket.close(4001, error);
  };
  const authTimer = setTimeout(
    () => fail('auth_timeout', 'No auth message.'),
    WS_AUTH_TIMEOUT_MS,
  );

  socket.on('message', (data) => {
    void (async () => {
      let message: LiveClientMessage;
      try {
        message = JSON.parse(data.toString()) as LiveClientMessage;
      } catch {
        return fail('bad_message', 'Messages must be JSON.');
      }

      if (!actor) {
        if (message.type !== 'auth') {
          return fail('auth_required', 'Send auth first.');
        }
        clearTimeout(authTimer);
        const outcome = await authenticate(message.initData, authOptions);
        if (!outcome.ok) {
          return fail(outcome.error, outcome.message);
        }
        actor = outcome.actor;
        return send({ type: 'ready', role: actor.role });
      }

      if (message.type === 'subscribe') {
        unsubscribe.forEach((stop) => stop());
        unsubscribe = [];
        const alias = String(message.server);
        if (!state.rcon(alias)) {
          return send({
            type: 'error',
            error: 'unknown_server',
            message: `There's no server "${alias}" any more.`,
          });
        }
        unsubscribe.push(
          state.statusWatcher(alias).subscribe((update) =>
            send(
              update.ok
                ? { type: 'status', status: update.status }
                : {
                    type: 'statusError',
                    server: alias,
                    message: update.message,
                  },
            ),
          ),
        );
        const feed = state.chatFeed(alias);
        if (feed) {
          unsubscribe.push(
            feed.subscribe((line) =>
              send({ type: 'chat', server: alias, line }),
            ),
          );
        }
      }
    })().catch((error: unknown) => {
      console.error('Mini App: live socket message failed:', error);
      fail('internal', 'Something went wrong on the bot.');
    });
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    unsubscribe.forEach((stop) => stop());
  });
}

/** Starts the Mini App's HTTP server alongside the bot (main.ts). */
export async function startMiniAppServer(
  deps: GatewayDeps,
  options: MiniAppServerOptions & { host: string; port: number },
): Promise<FastifyInstance> {
  const app = await createMiniAppServer(deps, options);
  await app.listen({ host: options.host, port: options.port });
  return app;
}
