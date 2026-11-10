import {
  createMemoryMcpRepository,
  type Permission,
} from '@cod2admin/admin-store';
import { describe, expect, it, vi } from 'vitest';
import { McpSessions, pkceChallenge } from '../../mcp/sessions.js';
import type { ActingAdmin } from '../bot-context.js';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { sampleAdmin } from '../testing/fake-admin-store.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import {
  approveTokenFromStart,
  mcpCommand,
  mcpDecision,
  mcpStart,
} from './mcp.js';

const VERIFIER = 'c'.repeat(50);

function setup(permissions: Permission[] = ['kick']) {
  const fake = createFakeDeps();
  const sessions = new McpSessions(createMemoryMcpRepository());
  fake.deps.mcp = { sessions, origin: 'https://admin.example' };
  const admin = sampleAdmin({ telegramId: 5, isOwner: false, permissions });
  fake.adminStore.getAdmin.mockResolvedValue(admin);
  return { ...fake, sessions, admin };
}

function acting(permissions: readonly Permission[] = ['kick']): ActingAdmin {
  return { telegramId: 5, isOwner: false, permissions };
}

function privateCtx(match = '') {
  return createFakeCtx({
    from: { id: 5 },
    chat: { id: 5, type: 'private' },
    admin: { telegramId: 5, isOwner: false, permissions: ['kick'] },
    match,
  });
}

async function pending(sessions: McpSessions) {
  return sessions.begin({
    clientId: 'https://app.example/client.json',
    clientName: 'Example App',
    redirectUri: 'http://127.0.0.1:8787/callback',
    codeChallenge: pkceChallenge(VERIFIER),
    resource: 'https://admin.example/mcp',
    scope: 'read kick ban',
    state: 'xyz',
  });
}

describe('approveTokenFromStart', () => {
  it('keeps underscores that belong to the token', () => {
    expect(approveTokenFromStart('mcp_ab_cd')).toBe('ab_cd');
    expect(approveTokenFromStart(' mcp_ab ')).toBe('ab');
    expect(approveTokenFromStart('hello')).toBeUndefined();
    expect(approveTokenFromStart('mcp_')).toBeUndefined();
  });
});

describe('mcpCommand', () => {
  it('lists connections only in a private chat', async () => {
    const { deps } = setup();
    const ctx = privateCtx();

    await mcpCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('https://admin.example/mcp'),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Nothing is connected.'),
    );
  });

  it('refuses a group', async () => {
    const { deps } = setup();
    const ctx = createFakeCtx({ chat: { id: -1, type: 'supergroup' } });

    await mcpCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(
      'Open a private chat with the bot to manage AI connections.',
    );
  });
});

describe('mcpStart', () => {
  it('shows the request and does not approve it', async () => {
    const { deps, sessions } = setup();
    const request = await pending(sessions);
    const ctx = privateCtx(`mcp_${request.approveToken}`);

    await mcpStart(ctx, deps);

    const text = String(vi.mocked(ctx.reply).mock.calls[0]?.[0]);
    expect(text).toContain('Example App');
    expect(text).toContain('127.0.0.1:8787');
    expect(text).toContain('kick, ban');
    expect(text).toContain('kick');
    expect(text).not.toContain('Connected');
    const buttons = buttonsOf(vi.mocked(ctx.reply).mock.calls[0]?.[1]);
    expect(buttons.map((button) => button.text)).toEqual([
      'Allow kick',
      'Allow read only',
      'Deny',
    ]);
    expect(
      await sessions.poll(request.browserToken, 'https://admin.example'),
    ).toEqual({
      status: 'pending',
    });
  });

  it('refuses someone who is not staff, and a request someone else opened', async () => {
    const { deps, sessions, adminStore } = setup();
    adminStore.getAdmin.mockResolvedValue(undefined);
    const request = await pending(sessions);
    const stranger = privateCtx(`mcp_${request.approveToken}`);

    await mcpStart(stranger, deps);
    expect(stranger.reply).toHaveBeenCalledWith(
      'Only a staff account can connect an AI.',
    );

    adminStore.getAdmin.mockResolvedValue(
      sampleAdmin({ telegramId: 5, isOwner: false, permissions: ['kick'] }),
    );
    await mcpStart(privateCtx(`mcp_${request.approveToken}`), deps);
    const other = privateCtx(`mcp_${request.approveToken}`);
    other.from = { id: 9 };
    adminStore.getAdmin.mockResolvedValue(
      sampleAdmin({ telegramId: 9, isOwner: false, permissions: ['kick'] }),
    );
    await mcpStart(other, deps);
    expect(other.reply).toHaveBeenCalledWith(
      'Someone else already opened this connection request.',
    );
  });

  it('offers read only when the person holds none of the asked actions', async () => {
    const { deps, sessions } = setup([]);
    const request = await pending(sessions);
    const ctx = privateCtx(`mcp_${request.approveToken}`);

    await mcpStart(ctx, deps);

    expect(
      buttonsOf(vi.mocked(ctx.reply).mock.calls[0]?.[1]).map(
        (button) => button.text,
      ),
    ).toEqual(['Allow read only', 'Deny']);
  });
});

describe('mcpDecision', () => {
  it('stores the overlap and refuses the button in a group', async () => {
    const { deps, sessions } = setup();
    const request = await pending(sessions);
    const opened = await sessions.open(request.approveToken, 5);
    if (typeof opened === 'string') {
      throw new Error(opened);
    }
    expect((await sessions.describe(opened.publicId))?.telegramId).toBe(5);
    const answer = vi.fn(async () => undefined);
    const edit = vi.fn(async () => undefined);
    await mcpDecision(
      {
        fromId: 5,
        admin: acting(),
        data: `mcp:allow:${opened.publicId}`,
        privateChat: false,
        answer,
        edit,
      },
      deps,
    );
    expect(answer).toHaveBeenCalledWith(
      'Open a private chat with the bot to connect an AI.',
    );
    expect(
      await sessions.poll(request.browserToken, 'https://admin.example'),
    ).toEqual({
      status: 'pending',
    });

    await mcpDecision(
      {
        fromId: 5,
        admin: acting(),
        data: `mcp:allow:${opened.publicId}`,
        privateChat: true,
        answer,
        edit,
      },
      deps,
    );
    expect(edit).toHaveBeenCalledWith(
      'Connected with kick. Go back to the browser page. End it with /mcp revoke.',
    );
    const polled = await sessions.poll(
      request.browserToken,
      'https://admin.example',
    );
    expect(polled.status).toBe('approved');
  });

  it('turns an empty allow into read only', async () => {
    const { deps, sessions } = setup([]);
    const request = await pending(sessions);
    const opened = await sessions.open(request.approveToken, 5);
    if (typeof opened === 'string') {
      throw new Error(opened);
    }
    const edit = vi.fn(async () => undefined);

    await mcpDecision(
      {
        fromId: 5,
        admin: acting([]),
        data: `mcp:allow:${opened.publicId}`,
        privateChat: true,
        answer: async () => undefined,
        edit,
      },
      deps,
    );

    expect(edit).toHaveBeenCalledWith(
      'Connected, read only. Go back to the browser page. End it with /mcp revoke.',
    );
  });
});

function buttonsOf(other: unknown): { text: string; callback_data: string }[] {
  const keyboard = other as {
    reply_markup?: {
      inline_keyboard?: { text: string; callback_data: string }[][];
    };
  };
  return (keyboard.reply_markup?.inline_keyboard ?? []).flat();
}
