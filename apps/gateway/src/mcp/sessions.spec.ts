import {
  createMemoryMcpRepository,
  type Permission,
} from '@cod2admin/admin-store';
import { describe, expect, it } from 'vitest';
import {
  McpSessions,
  pkceChallenge,
  pkceVerifierOk,
  type IssuedTokens,
  type OAuthFailure,
} from './sessions.js';

const CLIENT = 'https://app.example/client.json';
const REDIRECT = 'http://127.0.0.1:8787/callback';
const RESOURCE = 'https://admin.example/mcp';
const VERIFIER = 'a'.repeat(50);

function harness(start = new Date('2026-11-07T12:00:00.000Z')) {
  let now = start;
  const sessions = new McpSessions(createMemoryMcpRepository(), () => now);
  return {
    sessions,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

async function begin(sessions: McpSessions) {
  return sessions.begin({
    clientId: CLIENT,
    clientName: 'Example App',
    redirectUri: REDIRECT,
    codeChallenge: pkceChallenge(VERIFIER),
    resource: RESOURCE,
    scope: 'read kick ban',
    state: 'xyz',
  });
}

function codeOf(redirect: string): string {
  return new URL(redirect).searchParams.get('code') ?? '';
}

function isFailure(value: IssuedTokens | OAuthFailure): value is OAuthFailure {
  return 'error' in value;
}

async function exchange(
  sessions: McpSessions,
  code: string,
  overrides: Partial<{
    verifier: string;
    clientId: string;
    redirectUri: string;
    resource: string;
  }> = {},
) {
  return sessions.exchangeCode({
    code,
    verifier: overrides.verifier ?? VERIFIER,
    clientId: overrides.clientId ?? CLIENT,
    redirectUri: overrides.redirectUri ?? REDIRECT,
    resource: overrides.resource ?? RESOURCE,
  });
}

describe('McpSessions', () => {
  it('accepts a PKCE verifier and rejects a short one', () => {
    expect(pkceVerifierOk(VERIFIER)).toBe(true);
    expect(pkceVerifierOk('short')).toBe(false);
    expect(pkceChallenge(VERIFIER)).toMatch(/^[A-Za-z0-9\-_]{43,128}$/);
  });

  it('does not approve anything when the Telegram link is opened', async () => {
    const { sessions } = harness();
    const pending = await begin(sessions);

    expect(await sessions.open(pending.approveToken, 7)).toMatchObject({
      clientName: 'Example App',
      redirectHost: '127.0.0.1:8787',
    });
    expect(
      await sessions.poll(pending.browserToken, 'https://admin.example'),
    ).toEqual({
      status: 'pending',
    });
    expect(await sessions.open(pending.approveToken, 8)).toBe('taken');
  });

  it('issues one code for an approval and keeps a read-only choice smaller than the request', async () => {
    const { sessions } = harness();
    const pending = await begin(sessions);
    await sessions.open(pending.approveToken, 7);
    expect(await sessions.decide(pending.publicId, 7, 'read', [])).toBe(true);

    const polled = await sessions.poll(
      pending.browserToken,
      'https://admin.example',
    );
    expect(polled.status).toBe('approved');
    if (polled.status !== 'approved') {
      return;
    }
    const url = new URL(polled.redirect);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('xyz');
    expect(url.searchParams.get('iss')).toBe('https://admin.example');

    const tokens = await exchange(sessions, codeOf(polled.redirect));
    expect(isFailure(tokens)).toBe(false);
    if (isFailure(tokens)) {
      return;
    }
    expect(tokens.scope).toBe('read');
    expect(tokens.expiresIn).toBe(600);
    expect(await sessions.authenticate(tokens.accessToken)).toMatchObject({
      telegramId: 7,
      permissions: [],
    });
    expect(
      await sessions.poll(pending.browserToken, 'https://admin.example'),
    ).toEqual({
      status: 'used',
    });
  });

  it('leaves the code unused when PKCE or the client does not match', async () => {
    const { sessions } = harness();
    const pending = await begin(sessions);
    await sessions.open(pending.approveToken, 7);
    await sessions.decide(pending.publicId, 7, 'allow', [
      'kick',
    ] as Permission[]);
    const polled = await sessions.poll(
      pending.browserToken,
      'https://admin.example',
    );
    if (polled.status !== 'approved') {
      throw new Error(polled.status);
    }
    const code = codeOf(polled.redirect);

    expect(
      await exchange(sessions, code, { verifier: 'b'.repeat(50) }),
    ).toMatchObject({
      error: 'invalid_grant',
    });
    expect(
      await exchange(sessions, code, {
        clientId: 'https://other.example/client.json',
      }),
    ).toMatchObject({
      error: 'invalid_grant',
    });
    const tokens = await exchange(sessions, code);
    expect(isFailure(tokens)).toBe(false);
    if (!isFailure(tokens)) {
      expect(tokens.scope).toBe('read kick');
    }
  });

  it('revokes the connection when an authorization code is presented twice', async () => {
    const { sessions } = harness();
    const pending = await begin(sessions);
    await sessions.open(pending.approveToken, 7);
    await sessions.decide(pending.publicId, 7, 'allow', [
      'kick',
    ] as Permission[]);
    const polled = await sessions.poll(
      pending.browserToken,
      'https://admin.example',
    );
    if (polled.status !== 'approved') {
      throw new Error(polled.status);
    }
    const code = codeOf(polled.redirect);
    const tokens = await exchange(sessions, code);
    expect(await exchange(sessions, code)).toMatchObject({
      error: 'invalid_grant',
    });
    if (!isFailure(tokens)) {
      expect(await sessions.authenticate(tokens.accessToken)).toBeUndefined();
    }
  });

  it('revokes the connection when two exchanges race', async () => {
    const { sessions } = harness();
    const pending = await begin(sessions);
    await sessions.open(pending.approveToken, 7);
    await sessions.decide(pending.publicId, 7, 'allow', [
      'kick',
    ] as Permission[]);
    const polled = await sessions.poll(
      pending.browserToken,
      'https://admin.example',
    );
    if (polled.status !== 'approved') {
      throw new Error(polled.status);
    }
    const code = codeOf(polled.redirect);
    const [first, second] = await Promise.all([
      exchange(sessions, code),
      exchange(sessions, code),
    ]);

    expect([first, second].some(isFailure)).toBe(true);
    for (const result of [first, second]) {
      if (!isFailure(result)) {
        expect(await sessions.authenticate(result.accessToken)).toBeUndefined();
      }
    }
  });

  it('rotates refresh tokens and revokes the connection when an old one is reused', async () => {
    const { sessions } = harness();
    const pending = await begin(sessions);
    await sessions.open(pending.approveToken, 7);
    await sessions.decide(pending.publicId, 7, 'allow', [
      'kick',
    ] as Permission[]);
    const polled = await sessions.poll(
      pending.browserToken,
      'https://admin.example',
    );
    if (polled.status !== 'approved') {
      throw new Error(polled.status);
    }
    const tokens = await exchange(sessions, codeOf(polled.redirect));
    if (isFailure(tokens)) {
      throw new Error(tokens.description);
    }
    const rotated = await sessions.refresh({
      refreshToken: tokens.refreshToken,
      clientId: CLIENT,
      resource: RESOURCE,
    });
    if (isFailure(rotated)) {
      throw new Error(rotated.description);
    }
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    expect(await sessions.authenticate(tokens.accessToken)).toBeDefined();

    expect(
      await sessions.refresh({
        refreshToken: tokens.refreshToken,
        clientId: CLIENT,
        resource: RESOURCE,
      }),
    ).toMatchObject({ error: 'invalid_grant' });
    expect(await sessions.authenticate(rotated.accessToken)).toBeUndefined();
    expect(
      await sessions.refresh({
        refreshToken: rotated.refreshToken,
        clientId: CLIENT,
        resource: RESOURCE,
      }),
    ).toMatchObject({ error: 'invalid_grant' });
  });

  it('stops accepting an access token after 10 minutes and a refresh token after 14 days', async () => {
    const { sessions, advance } = harness();
    const pending = await begin(sessions);
    await sessions.open(pending.approveToken, 7);
    await sessions.decide(pending.publicId, 7, 'allow', [
      'kick',
    ] as Permission[]);
    const polled = await sessions.poll(
      pending.browserToken,
      'https://admin.example',
    );
    if (polled.status !== 'approved') {
      throw new Error(polled.status);
    }
    const tokens = await exchange(sessions, codeOf(polled.redirect));
    if (isFailure(tokens)) {
      throw new Error(tokens.description);
    }

    advance(10 * 60_000);
    expect(await sessions.authenticate(tokens.accessToken)).toBeUndefined();
    advance(14 * 24 * 60 * 60_000);
    expect(
      await sessions.refresh({
        refreshToken: tokens.refreshToken,
        clientId: CLIENT,
        resource: RESOURCE,
      }),
    ).toMatchObject({ error: 'invalid_grant' });
  });

  it('sends a denial back to the app without a code', async () => {
    const { sessions } = harness();
    const pending = await begin(sessions);
    await sessions.open(pending.approveToken, 7);
    await sessions.decide(pending.publicId, 7, 'deny', []);
    const polled = await sessions.poll(
      pending.browserToken,
      'https://admin.example',
    );

    expect(polled.status).toBe('denied');
    if (polled.status === 'denied') {
      const url = new URL(polled.redirect);
      expect(url.searchParams.get('error')).toBe('access_denied');
      expect(url.searchParams.get('code')).toBeNull();
      expect(url.searchParams.get('iss')).toBe('https://admin.example');
    }
  });
});
