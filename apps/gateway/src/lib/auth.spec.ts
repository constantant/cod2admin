import { describe, expect, it, vi } from 'vitest';
import { requireOwner } from './auth.js';
import { createFakeCtx } from './testing/fake-ctx.js';

describe('requireOwner', () => {
  it('calls next() for the configured owner', async () => {
    const middleware = requireOwner(42);
    const ctx = createFakeCtx({ from: { id: 42 } });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('replies "Not authorized." and skips next() for anyone else', async () => {
    const middleware = requireOwner(42);
    const ctx = createFakeCtx({ from: { id: 999 } });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Not authorized.');
  });

  it('denies updates with no `from` (e.g. channel posts)', async () => {
    const middleware = requireOwner(42);
    const ctx = createFakeCtx({ from: undefined });
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
  });
});
