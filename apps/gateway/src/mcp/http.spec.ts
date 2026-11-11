import {
  createMemoryMcpRepository,
  type Permission,
} from '@cod2admin/admin-store';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleAdmin } from '../lib/testing/fake-admin-store.js';
import { createFakeDeps, type FakeDeps } from '../lib/testing/fake-deps.js';
import { createMiniAppServer } from '../miniapp/server.js';
import { McpSessions, pkceChallenge } from './sessions.js';

const ORIGIN = 'https://admin.example';
const RESOURCE = `${ORIGIN}/mcp`;
const CLIENT_ID = 'https://app.example/client.json';
const REDIRECT = 'http://127.0.0.1:8787/callback';
const VERIFIER = 'a'.repeat(50);
const TELEGRAM_ID = 42;

const SERVER = {
  alias: 'default',
  rconHost: '203.0.113.10',
  rconPort: 28960,
  rconPassword: 'super-secret-password',
  logSourceConfig: '/var/log/games_mp.log',
  boundTelegramChatId: null,
  isDefault: true,
  watch: null,
  watchPrivatePassword: null,
  watchPrivatePasswordOwned: false,
};

describe('MCP HTTP', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('advertises OAuth metadata without open registration or Telegram-only scopes', async () => {
    app = (await start()).app;
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    const body = response.json<{
      registration_endpoint?: string;
      code_challenge_methods_supported: string[];
      client_id_metadata_document_supported: boolean;
      scopes_supported: string[];
      issuer: string;
    }>();

    expect(response.statusCode).toBe(200);
    expect(body.issuer).toBe(ORIGIN);
    expect(body.registration_endpoint).toBeUndefined();
    expect(body.client_id_metadata_document_supported).toBe(true);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    for (const hidden of [
      'update',
      'relays',
      'admins.manage',
      'servers.manage',
      'watch.manage',
      'mute',
    ]) {
      expect(body.scopes_supported).not.toContain(hidden);
    }
  });

  it('requires a bearer token even when the Mini App dev login is on', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.getAdmin.mockResolvedValue(
      sampleAdmin({
        telegramId: TELEGRAM_ID,
        isOwner: false,
        permissions: ['kick'],
      }),
    );
    app = await createMiniAppServer(deps, {
      botToken: '123456:TEST-token',
      devTelegramId: TELEGRAM_ID,
      mcp: mcpOptions(deps),
    });

    const api = await app.inject({ method: 'GET', url: '/api/me' });
    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });

    expect(api.statusCode).toBe(200);
    expect(mcp.statusCode).toBe(401);
    expect(mcp.json()).toEqual({ error: 'invalid_token' });
    expect(mcp.headers['www-authenticate']).toContain(
      'resource_metadata="https://admin.example/.well-known/oauth-protected-resource/mcp"',
    );
    expect(mcp.headers['x-content-type-options']).toBe('nosniff');
  });

  it('renders a 400 page for a bad authorize request and does not redirect', async () => {
    app = (await start()).app;
    const response = await app.inject({
      method: 'GET',
      url: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: 'https://evil.example/steal',
        code_challenge: pkceChallenge(VERIFIER),
        code_challenge_method: 'S256',
        resource: RESOURCE,
        state: 'xyz',
        scope: 'kick',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['location']).toBeUndefined();
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).not.toContain('evil.example');
    expect(response.body).toContain('not registered');
  });

  it('escapes the client name and keeps the browser token out of the page', async () => {
    const started = await start({
      clientName: '<script>alert(1)</script>',
    });
    app = started.app;
    const response = await authorize(app, 'kick');

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('&lt;script&gt;');
    expect(response.body).not.toContain('<script>alert');
    expect(response.body).not.toContain(cookie(response));
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(response.headers['content-security-policy']).toContain(
      "connect-src 'self'",
    );
    expect(response.body).toContain('target="_blank"');
    expect(response.body).toContain('Leave this page open');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(response.headers['set-cookie'])).toContain('Secure');
  });

  it('lists only the approved actions and never a server password', async () => {
    const started = await start();
    app = started.app;
    const { adminStore } = started.deps;
    adminStore.listServers.mockResolvedValue([SERVER]);
    adminStore.getDefaultServer.mockResolvedValue(SERVER);
    const token = await approve(started, ['kick', 'servers.view']);

    const listed = await rpc(app, token, 'tools/list');
    const names = listed
      .json<{ result: { tools: { name: string }[] } }>()
      .result.tools.map((tool) => tool.name);
    expect(names).toContain('kick');
    expect(names).toContain('list_servers');
    expect(names).not.toContain('ban');
    expect(names).not.toContain('rcon');
    expect(names).not.toContain('recent_chat');

    const servers = await rpc(app, token, 'tools/call', {
      name: 'list_servers',
      arguments: {},
    });
    const text = servers.json<{ result: { content: { text: string }[] } }>()
      .result.content[0]!.text;
    expect(text).toContain('203.0.113.10');
    expect(text).not.toContain('super-secret-password');
    expect(text).not.toContain('games_mp.log');

    const banned = await rpc(app, token, 'tools/call', {
      name: 'ban',
      arguments: { player: '1' },
    });
    expect(banned.json<{ result: { isError: boolean } }>().result.isError).toBe(
      true,
    );

    adminStore.getAdmin.mockResolvedValue(
      sampleAdmin({ telegramId: TELEGRAM_ID, isOwner: false, permissions: [] }),
    );
    const after = await rpc(app, token, 'tools/list');
    const remaining = after
      .json<{ result: { tools: { name: string }[] } }>()
      .result.tools.map((tool) => tool.name);
    expect(remaining).not.toContain('kick');
    expect(remaining).toContain('recent_chat');
  });

  it('does not gain a permission the person receives after approval', async () => {
    const started = await start({ permissions: ['kick'] });
    app = started.app;
    const token = await approve(started, []);

    const listed = await rpc(app, token, 'tools/list');
    const names = listed
      .json<{ result: { tools: { name: string }[] } }>()
      .result.tools.map((tool) => tool.name);
    expect(names).not.toContain('kick');
  });

  it('rejects an unknown protocol version and a batch', async () => {
    const started = await start();
    app = started.app;
    const version = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '1999-01-01',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(version.statusCode).toBe(400);

    const token = await approve(started, ['kick']);
    const batch = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: [{ jsonrpc: '2.0', id: 1, method: 'ping' }],
    });
    expect(batch.json<{ error: { code: number } }>().error.code).toBe(-32600);
    expect(await app.inject({ method: 'GET', url: '/mcp' })).toMatchObject({
      statusCode: 405,
    });
  });
});

function mcpOptions(
  deps: FakeDeps['deps'],
  sessions = new McpSessions(createMemoryMcpRepository()),
) {
  return {
    origin: ORIGIN,
    sessions,
    deps,
    botUsername: () => 'cod2admin_bot',
    loadMetadata: async () => ({
      clientId: CLIENT_ID,
      clientName: 'Example App',
      redirectUris: [REDIRECT],
    }),
  };
}

async function start(options?: {
  permissions?: Permission[];
  clientName?: string;
}) {
  const fake = createFakeDeps();
  fake.adminStore.getAdmin.mockResolvedValue(
    sampleAdmin({
      telegramId: TELEGRAM_ID,
      isOwner: false,
      permissions: options?.permissions ?? ['kick', 'servers.view', 'ban'],
    }),
  );
  const sessions = new McpSessions(createMemoryMcpRepository());
  const server = await createMiniAppServer(fake.deps, {
    botToken: '123456:TEST-token',
    mcp: {
      ...mcpOptions(fake.deps, sessions),
      loadMetadata: async () => ({
        clientId: CLIENT_ID,
        clientName: options?.clientName ?? 'Example App',
        redirectUris: [REDIRECT],
      }),
    },
  });
  return { app: server, sessions, deps: fake };
}

function cookie(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? String(raw[0]) : String(raw);
  const match = /mcp_oauth=([^;]+)/.exec(header);
  if (!match?.[1]) {
    throw new Error(`missing oauth cookie in ${header}`);
  }
  return decodeURIComponent(match[1]);
}

function approveToken(html: string): string {
  const match = /start=mcp_([^"&]+)/.exec(html);
  if (!match?.[1]) {
    throw new Error('approval link missing');
  }
  return decodeURIComponent(match[1]);
}

function authorize(server: FastifyInstance, scope: string) {
  return server.inject({
    method: 'GET',
    url: '/oauth/authorize',
    query: {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: pkceChallenge(VERIFIER),
      code_challenge_method: 'S256',
      resource: RESOURCE,
      state: 'xyz',
      scope,
    },
  });
}

async function approve(
  started: Awaited<ReturnType<typeof start>>,
  snapshot: Permission[],
): Promise<string> {
  const page = await authorize(started.app, 'kick ban servers.view');
  expect(page.statusCode).toBe(200);
  const opened = await started.sessions.open(
    approveToken(page.body),
    TELEGRAM_ID,
  );
  if (typeof opened !== 'object') {
    throw new Error(opened);
  }
  await started.sessions.decide(
    opened.publicId,
    TELEGRAM_ID,
    snapshot.length ? 'allow' : 'read',
    snapshot,
  );
  const pending = await started.app.inject({
    method: 'GET',
    url: '/oauth/pending',
    headers: { cookie: `mcp_oauth=${cookie(page)}` },
  });
  const redirect = pending.json<{ redirect?: string }>().redirect;
  if (!redirect) {
    throw new Error(pending.body);
  }
  const code = new URL(redirect).searchParams.get('code');
  const token = await started.app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code ?? '',
      code_verifier: VERIFIER,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
    }).toString(),
  });
  expect(token.statusCode).toBe(200);
  expect(token.headers['cache-control']).toBe('no-store');
  return token.json<{ access_token: string }>().access_token;
}

function rpc(
  server: FastifyInstance,
  token: string,
  method: string,
  params?: Record<string, unknown>,
) {
  return server.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
}
