import { describe, expect, it } from 'vitest';
import { broadcastModerationAction } from './broadcast.js';
import { DEFAULT_CHAT_TEMPLATES } from './chat-templates.js';
import { asRconClient, createFakeRcon } from './testing/fake-rcon.js';

describe('broadcastModerationAction', () => {
  it('says a sanitized announcement in-game', async () => {
    const fake = createFakeRcon();

    await broadcastModerationAction(
      asRconClient(fake),
      DEFAULT_CHAT_TEMPLATES.kick,
      { name: 'Cheater; banUser 0' },
    );

    expect(fake.say).toHaveBeenCalledWith(
      'Cheater banUser 0 was kicked by an admin',
    );
  });

  it('says nothing when the template is empty', async () => {
    const fake = createFakeRcon();

    await broadcastModerationAction(asRconClient(fake), '', {
      name: 'Cheater',
    });

    expect(fake.say).not.toHaveBeenCalled();
  });
});
