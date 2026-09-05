import type { ServerStatus } from '@cod2admin/rcon-client';
import { describe, expect, it } from 'vitest';
import { createFakeEditableCtx, createFakeCtx } from '../testing/fake-ctx.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { formatStatusMessage, statusCommand, statusRefreshCallback } from './status.js';

const SAMPLE_STATUS: ServerStatus = {
  raw: '',
  mapName: 'mp_toujane',
  hostname: 'Test Server',
  players: [{ num: 0, score: 5, ping: 42, name: 'PlayerOne' }],
};

describe('formatStatusMessage', () => {
  it('formats hostname, map, and player count/max', () => {
    expect(formatStatusMessage(SAMPLE_STATUS, { sv_maxclients: '32' })).toBe(
      ['Server: Test Server', 'Map: mp_toujane', 'Players: 1/32'].join('\n'),
    );
  });

  it('falls back to placeholders for missing fields', () => {
    expect(formatStatusMessage({ raw: '', players: [] }, {})).toBe(
      ['Server: unknown', 'Map: unknown', 'Players: 0/?'].join('\n'),
    );
  });
});

describe('statusCommand', () => {
  it('replies with the status message and a Refresh keyboard', async () => {
    const fake = createFakeRcon();
    fake.status.mockResolvedValue(SAMPLE_STATUS);
    fake.getInfo.mockResolvedValue({ sv_maxclients: '32' });
    const ctx = createFakeCtx();

    await statusCommand(ctx, asRconClient(fake));

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Map: mp_toujane'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });
});

describe('statusRefreshCallback', () => {
  it('edits the message in place and answers the callback query', async () => {
    const fake = createFakeRcon();
    fake.status.mockResolvedValue(SAMPLE_STATUS);
    fake.getInfo.mockResolvedValue({ sv_maxclients: '32' });
    const ctx = createFakeEditableCtx();

    await statusRefreshCallback(ctx, asRconClient(fake));

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Map: mp_toujane'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
  });
});
