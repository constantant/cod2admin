import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { bindServerCommand } from './bindserver.js';

describe('bindServerCommand', () => {
  it('binds the current chat to a known server', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'default', chat: { id: 100 } });

    await bindServerCommand(ctx, deps);

    expect(adminStore.bindServerToChat).toHaveBeenCalledWith('default', 100);
    expect(ctx.reply).toHaveBeenCalledWith('This chat is now bound to server "default".');
  });

  it('rejects an unknown server alias', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: 'nope', chat: { id: 100 } });

    await bindServerCommand(ctx, deps);

    expect(adminStore.bindServerToChat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Unknown server "nope". Run /servers to see what\'s configured.');
  });

  it('prompts for usage when no alias is given', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ match: '', chat: { id: 100 } });

    await bindServerCommand(ctx, deps);

    expect(adminStore.bindServerToChat).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /bindserver <alias>');
  });
});
