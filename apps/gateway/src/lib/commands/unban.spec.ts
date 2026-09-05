import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { unbanCommand } from './unban.js';

describe('unbanCommand', () => {
  it('unbans the given GUID', async () => {
    const fake = createFakeRcon();
    const ctx = createFakeCtx({ match: 'GUID123' });

    await unbanCommand(ctx, asRconClient(fake));

    expect(fake.unbanUser).toHaveBeenCalledWith('GUID123');
    expect(ctx.reply).toHaveBeenCalledWith('Unbanned GUID GUID123.');
  });

  it('prompts for usage when no GUID is given', async () => {
    const fake = createFakeRcon();
    const ctx = createFakeCtx({ match: '' });

    await unbanCommand(ctx, asRconClient(fake));

    expect(fake.unbanUser).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /unban <guid>');
  });
});
