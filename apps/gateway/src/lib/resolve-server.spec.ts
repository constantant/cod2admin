import { describe, expect, it } from 'vitest';
import { extractServerFlag, resolveServer } from './resolve-server.js';
import { createFakeDeps } from './testing/fake-deps.js';
import { createFakeCtx } from './testing/fake-ctx.js';
import { asRconClient, createFakeRcon } from './testing/fake-rcon.js';

describe('extractServerFlag', () => {
  it('pulls a trailing --server <alias> token out and returns the rest', () => {
    expect(extractServerFlag('3 griefing --server default')).toEqual({ alias: 'default', rest: '3 griefing' });
  });

  it('pulls a leading --server <alias> token out too', () => {
    expect(extractServerFlag('--server default 3 griefing')).toEqual({ alias: 'default', rest: '3 griefing' });
  });

  it('returns the text unchanged when there is no --server flag', () => {
    expect(extractServerFlag('3 griefing')).toEqual({ alias: undefined, rest: '3 griefing' });
  });
});

describe('resolveServer', () => {
  it('resolves an explicit alias when it matches a configured server', async () => {
    const { deps } = createFakeDeps();
    const ctx = createFakeCtx();

    const server = await resolveServer(ctx, deps, 'default');

    expect(server).toEqual({ alias: 'default', rcon: deps.rconClients.get('default') });
  });

  it('replies with "Unknown server" for an alias that is not configured', async () => {
    const { deps } = createFakeDeps();
    const ctx = createFakeCtx();

    const server = await resolveServer(ctx, deps, 'nope');

    expect(server).toBeUndefined();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Unknown server "nope"'));
  });

  it('falls back to the chat-bound server when no explicit alias is given', async () => {
    const { deps, adminStore } = createFakeDeps();
    const otherRcon = createFakeRcon();
    deps.rconClients.set('other', asRconClient(otherRcon));
    adminStore.getServerForChat.mockResolvedValue({
      alias: 'other',
      rconHost: 'h',
      rconPort: 1,
      rconPassword: 'p',
      logSourceConfig: null,
      boundTelegramChatId: 100,
    });
    const ctx = createFakeCtx({ chat: { id: 100 } });

    const server = await resolveServer(ctx, deps, undefined);

    expect(server?.alias).toBe('other');
    expect(server?.rcon).toBe(asRconClient(otherRcon));
    expect(server?.rcon).not.toBe(deps.rconClients.get('default'));
  });

  it('falls back to the single configured server when there is exactly one', async () => {
    const { deps } = createFakeDeps();
    const ctx = createFakeCtx();

    const server = await resolveServer(ctx, deps, undefined);

    expect(server?.alias).toBe('default');
  });

  it('asks for --server when multiple servers are configured and none is bound/specified', async () => {
    const { deps } = createFakeDeps();
    deps.rconClients.set('other', asRconClient(createFakeRcon()));
    const ctx = createFakeCtx();

    const server = await resolveServer(ctx, deps, undefined);

    expect(server).toBeUndefined();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('--server'));
  });
});
