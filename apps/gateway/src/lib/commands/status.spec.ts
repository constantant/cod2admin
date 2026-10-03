import type { CvarMap, OobStatusPlayer } from '@cod2admin/rcon-client';
import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx, createFakeEditableCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { formatStatusMessage, statusCommand, statusRefreshCallback } from './status.js';

const SAMPLE_STATUS: { cvars: CvarMap; players: OobStatusPlayer[] } = {
  cvars: { sv_hostname: 'Test Server', mapname: 'mp_toujane', sv_maxclients: '32' },
  players: [{ score: 5, ping: 42, name: 'PlayerOne' }],
};

describe('formatStatusMessage', () => {
  it('formats hostname, map, and player count/max', () => {
    expect(formatStatusMessage(SAMPLE_STATUS.cvars, 1)).toBe(
      ['Server: Test Server', 'Map: mp_toujane', 'Players: 1/32'].join('\n'),
    );
  });

  it('strips color codes from the hostname', () => {
    expect(formatStatusMessage({ sv_hostname: 'CoD2 ^2CTF ^7RU^4SS^1IA' }, 0)).toContain('Server: CoD2 CTF RUSSIA');
  });

  it('falls back to placeholders for missing fields', () => {
    expect(formatStatusMessage({}, 0)).toBe(
      ['Server: unknown', 'Map: unknown', 'Players: 0/?'].join('\n'),
    );
  });
});

describe('statusCommand', () => {
  it('replies with the status message and a Refresh keyboard', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getStatus.mockResolvedValue(SAMPLE_STATUS);
    const ctx = createFakeCtx();

    await statusCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Map: mp_toujane'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });
});

describe('statusRefreshCallback', () => {
  it('edits the message in place and answers the callback query', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getStatus.mockResolvedValue(SAMPLE_STATUS);
    const ctx = createFakeEditableCtx();

    await statusRefreshCallback(ctx, deps);

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Map: mp_toujane'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
  });

  it('swallows a "message is not modified" error and still answers the callback query', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getStatus.mockResolvedValue(SAMPLE_STATUS);
    const ctx = createFakeEditableCtx({
      editMessageText: vi.fn().mockRejectedValue(new Error('Bad Request: message is not modified: blah')),
    });

    await expect(statusRefreshCallback(ctx, deps)).resolves.toBeUndefined();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
  });

  it('re-throws any other error from editMessageText', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getStatus.mockResolvedValue(SAMPLE_STATUS);
    const ctx = createFakeEditableCtx({ editMessageText: vi.fn().mockRejectedValue(new Error('network error')) });

    await expect(statusRefreshCallback(ctx, deps)).rejects.toThrow('network error');
  });
});
