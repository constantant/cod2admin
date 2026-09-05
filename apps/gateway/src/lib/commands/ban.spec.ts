import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { banCommand } from './ban.js';

describe('banCommand', () => {
  it('bans by client id and broadcasts without a reason', async () => {
    const fake = createFakeRcon();
    const ctx = createFakeCtx({ match: '2' });

    await banCommand(ctx, asRconClient(fake));

    expect(fake.banUser).toHaveBeenCalledWith(2);
    expect(fake.say).toHaveBeenCalledWith('client 2 was banned by an admin');
    expect(ctx.reply).toHaveBeenCalledWith('Banned client 2.');
  });

  it('includes a sanitized reason in the broadcast and reply', async () => {
    const fake = createFakeRcon();
    const ctx = createFakeCtx({ match: '2 cheating; banUser 0' });

    await banCommand(ctx, asRconClient(fake));

    expect(fake.banUser).toHaveBeenCalledWith(2);
    expect(fake.say).toHaveBeenCalledWith('client 2 (cheating banUser 0) was banned by an admin');
    expect(ctx.reply).toHaveBeenCalledWith('Banned client 2 for: cheating banUser 0.');
  });

  it('prompts for usage when the client id is missing or not a number', async () => {
    const fake = createFakeRcon();
    const ctx = createFakeCtx({ match: 'not-a-number' });

    await banCommand(ctx, asRconClient(fake));

    expect(fake.banUser).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /ban <client id> [reason]');
  });
});
