import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { kickCommand } from './kick.js';

describe('kickCommand', () => {
  it('kicks the target, broadcasts, and confirms', async () => {
    const fake = createFakeRcon();
    const ctx = createFakeCtx({ match: '3' });

    await kickCommand(ctx, asRconClient(fake));

    expect(fake.kick).toHaveBeenCalledWith('3');
    expect(fake.say).toHaveBeenCalledWith('3 was kicked by an admin');
    expect(ctx.reply).toHaveBeenCalledWith('Kicked 3.');
  });

  it('prompts for usage when no target is given', async () => {
    const fake = createFakeRcon();
    const ctx = createFakeCtx({ match: '' });

    await kickCommand(ctx, asRconClient(fake));

    expect(fake.kick).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /kick <client id or name>');
  });
});
