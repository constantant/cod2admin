import { InlineKeyboard } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { mapsCommand, mapsSelectCallback, type MapsCallbackContext } from './maps.js';

function createFakeCallbackCtx(overrides: Partial<MapsCallbackContext> = {}): MapsCallbackContext {
  return {
    admin: { telegramId: 1, role: 'admin' },
    callbackData: '',
    editMessageText: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('mapsCommand', () => {
  it('replies with a keyboard of the rotation maps', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getMapRotation.mockResolvedValue(['mp_toujane', 'mp_carentan']);
    const ctx = createFakeCtx();

    await mapsCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith(
      'Tap a map to switch to it:',
      expect.objectContaining({ reply_markup: expect.any(InlineKeyboard) }),
    );
    const keyboard = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup as InlineKeyboard;
    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toEqual(['mp_toujane', 'mp_carentan']);
    expect(keyboard.inline_keyboard.flat().map((button) => (button as { callback_data: string }).callback_data)).toEqual([
      'map:default:mp_toujane',
      'map:default:mp_carentan',
    ]);
  });

  it('replies with a plain message when the rotation is empty', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getMapRotation.mockResolvedValue([]);
    const ctx = createFakeCtx();

    await mapsCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledWith('No maps found in sv_mapRotation.');
  });
});

describe('mapsSelectCallback', () => {
  it('switches the map, audit-logs it as a button action, and edits the message', async () => {
    const { deps, rcon, adminStore } = createFakeDeps();
    const ctx = createFakeCallbackCtx({ callbackData: 'map:default:mp_toujane' });

    await mapsSelectCallback(ctx, deps);

    expect(rcon.map).toHaveBeenCalledWith('mp_toujane');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'map', target: 'mp_toujane', serverAlias: 'default', source: 'telegram_button' }),
    );
    expect(ctx.editMessageText).toHaveBeenCalledWith('Changing map to mp_toujane...');
    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
  });

  it('answers with an error for unrecognized callback data', async () => {
    const { deps, rcon } = createFakeDeps();
    const ctx = createFakeCallbackCtx({ callbackData: 'not-ours' });

    await mapsSelectCallback(ctx, deps);

    expect(rcon.map).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Unrecognized action.' });
  });

  it('answers with an error when the server is no longer configured', async () => {
    const { deps } = createFakeDeps();
    const ctx = createFakeCallbackCtx({ callbackData: 'map:missing:mp_toujane' });

    await mapsSelectCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Server no longer configured.' });
  });
});
