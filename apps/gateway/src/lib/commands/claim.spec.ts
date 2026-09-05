import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { claimCommand } from './claim.js';

describe('claimCommand', () => {
  it('claims ownership when the secret matches', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.claimOwner.mockResolvedValue('claimed');
    const ctx = createFakeCtx({ from: { id: 7 }, match: 'the-secret' });

    await claimCommand(ctx, deps, 'the-secret');

    expect(adminStore.claimOwner).toHaveBeenCalledWith(7);
    expect(ctx.reply).toHaveBeenCalledWith('You are now the owner.');
  });

  it('reports "Owner already set." when claimOwner says already-claimed', async () => {
    const { deps, adminStore } = createFakeDeps();
    adminStore.claimOwner.mockResolvedValue('already-claimed');
    const ctx = createFakeCtx({ from: { id: 7 }, match: 'the-secret' });

    await claimCommand(ctx, deps, 'the-secret');

    expect(ctx.reply).toHaveBeenCalledWith('Owner already set.');
  });

  it('rejects a wrong secret without touching the store', async () => {
    const { deps, adminStore } = createFakeDeps();
    const ctx = createFakeCtx({ from: { id: 7 }, match: 'wrong' });

    await claimCommand(ctx, deps, 'the-secret');

    expect(adminStore.claimOwner).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Invalid secret.');
  });

  it('prompts for usage when no secret is given', async () => {
    const { deps } = createFakeDeps();
    const ctx = createFakeCtx({ from: { id: 7 }, match: '' });

    await claimCommand(ctx, deps, 'the-secret');

    expect(ctx.reply).toHaveBeenCalledWith('Usage: /claim <secret>');
  });
});
