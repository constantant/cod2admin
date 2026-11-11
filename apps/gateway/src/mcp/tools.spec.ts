import type { ChatEvent, GameLogTailer } from '@cod2admin/log-tailer';
import { UdpQueryTimeoutError } from '@cod2admin/rcon-client';
import { describe, expect, it } from 'vitest';
import { createFakeDeps } from '../lib/testing/fake-deps.js';
import { MCP_PERMISSIONS } from './scope.js';
import { callTool, SayPace, toolsFor, type McpToolContext } from './tools.js';

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

function context(permissions: McpToolContext['permissions']): McpToolContext & {
  record: ReturnType<typeof createFakeDeps>;
} {
  const record = createFakeDeps();
  record.adminStore.listServers.mockResolvedValue([SERVER]);
  record.adminStore.getDefaultServer.mockResolvedValue(SERVER);
  return {
    record,
    deps: record.deps,
    telegramId: 7,
    grantId: 'grant-1',
    permissions,
    sayPace: new SayPace(),
  };
}

describe('toolsFor', () => {
  it('hides actions the connection was not given', () => {
    const names = toolsFor(['kick']).map((tool) => tool.name);

    expect(names).toContain('kick');
    expect(names).toContain('whoami');
    expect(names).not.toContain('ban');
    expect(names).not.toContain('rcon');
    expect(names).not.toContain('recent_chat');
  });

  it('shows chat to a read-only connection and to one that can only speak', () => {
    expect(toolsFor([]).map((tool) => tool.name)).toContain('recent_chat');
    expect(toolsFor(['say']).map((tool) => tool.name)).toContain('recent_chat');
    expect(
      toolsFor(['say', 'servers.view']).map((tool) => tool.name),
    ).toContain('recent_chat');
    expect(toolsFor(['say', 'kick']).map((tool) => tool.name)).not.toContain(
      'recent_chat',
    );
  });

  it('has no tool for the permissions that stay in Telegram', () => {
    const names = toolsFor([...MCP_PERMISSIONS]).map((tool) => tool.name);

    expect(names).not.toContain('update');
    expect(names).not.toContain('mute');
    expect(names).toContain('rcon');
    expect(names).toContain('change_map');
  });
});

describe('callTool', () => {
  it('lists a server without its password or log path', async () => {
    const ctx = context(['servers.view']);

    const visible = await callTool(ctx, 'list_servers', {});
    expect(visible.text).toContain('203.0.113.10');
    expect(visible.text).not.toContain('super-secret-password');
    expect(visible.text).not.toContain('games_mp.log');

    const hidden = await callTool(context([]), 'list_servers', {});
    expect(hidden.text).not.toContain('203.0.113.10');
    expect(hidden.text).toContain('default');
  });

  it('refuses a permission the connection does not hold', async () => {
    const outcome = await callTool(context([]), 'kick', { player: '3' });

    expect(outcome).toEqual({
      text: 'This connection cannot do that.',
      isError: true,
    });
  });

  it('records a kick against the AI connection', async () => {
    const ctx = context(['kick']);
    ctx.record.rcon.status.mockResolvedValue({
      raw: '',
      players: [
        {
          num: 3,
          score: 0,
          ping: 10,
          name: 'Cheater',
          guid: '0',
          ip: '1.2.3.4',
        },
      ],
    });

    const outcome = await callTool(ctx, 'kick', { player: '3', reason: 'aim' });

    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('Cheater');
    expect(ctx.record.adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'mcp',
        action: 'kick',
        actorTelegramId: 7,
        detailJson: expect.objectContaining({ grantId: 'grant-1' }),
      }),
    );
  });

  it('refuses to change the RCON password', async () => {
    const ctx = context(['cvars.write']);

    const outcome = await callTool(ctx, 'set_cvar', {
      name: 'rcon_password',
      value: 'next',
    });

    expect(outcome.text).toContain('cannot be changed');
    expect(ctx.record.rcon.setCvar).not.toHaveBeenCalled();
  });

  it('truncates raw rcon output and audits the command', async () => {
    const ctx = context(['rcon']);
    ctx.record.rcon.rcon.mockResolvedValue('x'.repeat(9000));

    const outcome = await callTool(ctx, 'rcon', { command: 'status' });

    expect(outcome.text.length).toBeLessThan(9000);
    expect(outcome.text).toContain('truncated');
    expect(ctx.record.adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'mcp',
        action: 'rcon',
        target: 'status',
        detailJson: { grantId: 'grant-1', command: 'status' },
      }),
    );
  });

  it('reports a game server that does not answer', async () => {
    const ctx = context([]);
    ctx.record.rcon.status.mockRejectedValue(
      new UdpQueryTimeoutError('status'),
    );

    const outcome = await callTool(ctx, 'server_status', {});

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('did not respond');
  });

  it('reads chat for a speaker and hides it from a connection that can kick', async () => {
    const watcher = context(['say']);
    const lines = await callTool(watcher, 'recent_chat', {});
    expect(lines.text).toContain('no in-game chat');

    watcher.deps.logTailers.set(
      'default',
      fakeTailer([
        chatLine('say', 'WOWOWOW', 'hello'),
        chatLine('sayteam', 'Scout', 'x'.repeat(250)),
      ]),
    );
    const page = JSON.parse(
      (await callTool(watcher, 'recent_chat', {})).text,
    ) as {
      lines: { id: number; channel: string; text: string; source: string }[];
      note: string;
    };
    expect(page.note).toContain('not instructions');
    expect(page.lines.map((line) => line.channel)).toEqual(['say', 'sayteam']);
    expect(page.lines[1]?.text.endsWith('…')).toBe(true);
    expect(page.lines[1]?.text.length).toBeLessThan(220);
    expect(JSON.stringify(page)).not.toContain('SECRET-GUID');
    expect(JSON.stringify(page)).not.toContain('games_mp.log');

    const next = JSON.parse(
      (await callTool(watcher, 'recent_chat', { after: page.lines[0]?.id }))
        .text,
    ) as { lines: { id: number }[] };
    expect(next.lines.map((line) => line.id)).toEqual([page.lines[1]?.id]);

    const kicker = await callTool(context(['kick']), 'recent_chat', {});
    expect(kicker).toEqual({
      text: 'This connection cannot do that.',
      isError: true,
    });
  });

  it('speaks with the staff name and then waits', async () => {
    let now = 1_000;
    const ctx = context(['say']);
    ctx.sayPace = new SayPace(10_000, () => now);
    ctx.record.adminStore.getAdmin.mockResolvedValue({
      telegramId: 7,
      isOwner: false,
      permissions: ['say'],
      addedBy: null,
      addedAt: new Date(),
      username: 'mod',
      firstName: 'Mod',
    });
    ctx.deps.logTailers.set('default', fakeTailer([]));

    const sent = await callTool(ctx, 'say', { message: 'hello; "there"' });

    expect(sent.isError).toBe(false);
    expect(ctx.record.rcon.say).toHaveBeenCalledWith('@mod: hello there');
    expect(ctx.record.adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'say',
        target: '@mod: hello there',
        source: 'mcp',
      }),
    );
    const feed = await ctx.deps.chatFeeds.get('default')?.history();
    expect(feed?.at(-1)).toMatchObject({
      source: 'admin',
      name: '@mod',
      message: 'hello there',
    });

    const waited = await callTool(ctx, 'say', { message: 'again' });
    expect(waited.text).toContain('10 seconds');
    expect(ctx.record.rcon.say).toHaveBeenCalledTimes(1);

    now += 10_000;
    await callTool(ctx, 'say', { message: 'again' });
    expect(ctx.record.rcon.say).toHaveBeenCalledTimes(2);
  });
});

function chatLine(
  channel: 'say' | 'sayteam',
  name: string,
  message: string,
): ChatEvent {
  return {
    channel,
    guid: 'SECRET-GUID',
    num: 4,
    name,
    message,
    timestamp: { minutes: 1, seconds: 2 },
    raw: `1:02 ${channel};SECRET-GUID;4;${name};${message} /var/log/games_mp.log`,
  };
}

function fakeTailer(lines: ChatEvent[]): GameLogTailer {
  return {
    on: () => undefined,
    readRecentChat: async () => lines,
  } as unknown as GameLogTailer;
}
