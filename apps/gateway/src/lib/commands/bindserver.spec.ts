import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { bindServerCommand } from './bindserver.js';

describe('bindServerCommand', () => {
  it('binds the current chat as the public group by default', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'default', chat: { id: 100 } });

    await bindServerCommand(ctx, deps);

    expect(adminStore.bindServerToChat).toHaveBeenCalledWith(
      'default',
      100,
      'public',
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      'This chat is now the public group for server "default" (match results).',
    );
  });

  it('binds the admin chat with the "private" keyword', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'default private', chat: { id: 200 } });

    await bindServerCommand(ctx, deps);

    expect(adminStore.bindServerToChat).toHaveBeenCalledWith(
      'default',
      200,
      'admin',
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      'This chat is now the admin chat for server "default" (reports).',
    );
  });

  it('refuses "private" in a chat that is already a public group', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.listServers.mockResolvedValue([
      { alias: 'default', publicTelegramChatId: 200 } as never,
    ]);
    const ctx = createFakeCtx({ match: 'default private', chat: { id: 200 } });

    await bindServerCommand(ctx, deps);

    expect(adminStore.bindServerToChat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('public group'),
    );
  });

  it('refuses "private" in a group with a public username', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({
      match: 'default private',
      chat: { id: 300, type: 'supergroup', username: 'cod2ru' },
    });

    await bindServerCommand(ctx, deps);

    expect(adminStore.bindServerToChat).not.toHaveBeenCalled();
  });

  it('rejects an unknown second word', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'default foo', chat: { id: 200 } });

    await bindServerCommand(ctx, deps);

    expect(adminStore.bindServerToChat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      'Usage: /bindserver <alias> [private]',
    );
  });

  it('rejects an unknown server alias', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'nope', chat: { id: 100 } });

    await bindServerCommand(ctx, deps);

    expect(adminStore.bindServerToChat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      'Unknown server "nope". Run /servers to see what\'s configured.',
    );
  });

  it('prompts for usage when no alias is given', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', chat: { id: 100 } });

    await bindServerCommand(ctx, deps);

    expect(adminStore.bindServerToChat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /bindserver <alias> [private]');
  });
});
