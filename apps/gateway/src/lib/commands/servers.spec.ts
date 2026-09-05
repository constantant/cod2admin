import type { ServerConfig } from '@cod2admin/admin-store';
import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { formatServersMessage, serversCommand } from './servers.js';

const SERVER: ServerConfig = {
  alias: 'default',
  rconHost: '127.0.0.1',
  rconPort: 28960,
  rconPassword: 'pw',
  logSourceConfig: null,
  boundTelegramChatId: null,
};

describe('formatServersMessage', () => {
  it('formats one line per server', () => {
    expect(formatServersMessage([SERVER])).toBe('default — 127.0.0.1:28960');
  });

  it('notes the bound chat when set', () => {
    expect(formatServersMessage([{ ...SERVER, boundTelegramChatId: 100 }])).toBe(
      'default — 127.0.0.1:28960 (bound to chat 100)',
    );
  });

  it('reports no servers configured when the list is empty', () => {
    expect(formatServersMessage([])).toBe('No servers configured.');
  });
});

describe('serversCommand', () => {
  it('replies with the formatted server list', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.listServers.mockResolvedValue([SERVER]);
    const ctx = createFakeCtx();

    await serversCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith('default — 127.0.0.1:28960');
  });
});
