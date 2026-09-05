import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { mapCommand } from './map.js';

describe('mapCommand', () => {
  it('changes the map', async () => {
    const fake = createFakeRcon();
    const ctx = createFakeCtx({ match: 'mp_toujane' });

    await mapCommand(ctx, asRconClient(fake));

    expect(fake.map).toHaveBeenCalledWith('mp_toujane');
    expect(ctx.reply).toHaveBeenCalledWith('Changing map to mp_toujane...');
  });

  it('prompts for usage when no map name is given', async () => {
    const fake = createFakeRcon();
    const ctx = createFakeCtx({ match: '' });

    await mapCommand(ctx, asRconClient(fake));

    expect(fake.map).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Usage: /map <name>');
  });
});
