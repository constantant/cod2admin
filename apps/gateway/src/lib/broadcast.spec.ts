import { describe, expect, it } from 'vitest';
import { broadcastModerationAction } from './broadcast.js';
import { asRconClient, createFakeRcon } from './testing/fake-rcon.js';

describe('broadcastModerationAction', () => {
  it('says a sanitized announcement in-game (docs/PLAN.md §5/§6)', async () => {
    const fake = createFakeRcon();

    await broadcastModerationAction(asRconClient(fake), 'Cheater; banUser 0', 'kicked');

    expect(fake.say).toHaveBeenCalledWith('Cheater banUser 0 was kicked by an admin');
  });
});
