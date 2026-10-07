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
      'Maps in rotation — tap one to switch to it:',
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

    expect(ctx.reply).toHaveBeenCalledWith('No maps found in sv_mapRotation or on the server.');
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

describe('installed maps', () => {
  function buttons(ctx: ReturnType<typeof createFakeCtx>, call: number) {
    const keyboard = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[call][1].reply_markup as InlineKeyboard;
    return keyboard.inline_keyboard.flat().map((button) => [button.text, (button as { callback_data: string }).callback_data]);
  }

  it('adds a second message with the installed maps that are not in rotation, custom ones marked', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getMapRotation.mockResolvedValue(['mp_toujane', 'tuscany']);
    rcon.getInstalledMaps.mockResolvedValue(['mp_harbor', 'mp_toujane', 'rts', 'tuscany']);
    const ctx = createFakeCtx();

    await mapsCommand(ctx, deps);

    // A custom map already in rotation switches directly — the server plays it anyway.
    expect(buttons(ctx, 0)).toEqual([
      ['mp_toujane', 'map:default:mp_toujane'],
      ['tuscany', 'map:default:tuscany'],
    ]);
    const text = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(text).toContain('Other maps installed on default (2, not in rotation):');
    expect(text).toContain("⚠ = not a standard CoD2 map");
    expect(buttons(ctx, 1)).toEqual([
      ['mp_harbor', 'map:default:mp_harbor'],
      ['⚠ rts', 'mapask:default:rts'],
    ]);
  });

  it('still shows the rotation when the server cannot list its maps', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getMapRotation.mockResolvedValue(['mp_toujane']);
    rcon.getInstalledMaps.mockRejectedValue(new Error('timeout'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createFakeCtx();

    await mapsCommand(ctx, deps);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(buttons(ctx, 0)).toEqual([['mp_toujane', 'map:default:mp_toujane']]);
    error.mockRestore();
  });

  it('caps the extra buttons and points to /map for the rest', async () => {
    const { deps, rcon } = createFakeDeps();
    rcon.getInstalledMaps.mockResolvedValue(Array.from({ length: 75 }, (_, i) => `custom_${String(i).padStart(2, '0')}`));
    const ctx = createFakeCtx();

    await mapsCommand(ctx, deps);

    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('Showing 60; switch to the others with /map <name>.');
    expect(buttons(ctx, 0)).toHaveLength(60);
  });

  it('asks before switching to a custom map, then switches or cancels', async () => {
    const { deps, rcon } = createFakeDeps();
    const ask = createFakeCallbackCtx({ callbackData: 'mapask:default:rts' });

    await mapsSelectCallback(ask, deps);

    expect(rcon.map).not.toHaveBeenCalled();
    const [question, other] = vi.mocked(ask.editMessageText).mock.calls[0]!;
    expect(question).toBe(
      "Switch default to rts? It's not a standard CoD2 map: players who don't have it may be dropped unless the server offers downloads.",
    );
    const confirm = (other as { reply_markup: InlineKeyboard }).reply_markup.inline_keyboard.flat();
    expect(confirm.map((button) => (button as { callback_data: string }).callback_data)).toEqual([
      'map:default:rts',
      'mapno:default:rts',
    ]);

    const cancel = createFakeCallbackCtx({ callbackData: 'mapno:default:rts' });
    await mapsSelectCallback(cancel, deps);
    expect(cancel.editMessageText).toHaveBeenCalledWith('Map change to rts cancelled.');
    expect(rcon.map).not.toHaveBeenCalled();

    await mapsSelectCallback(createFakeCallbackCtx({ callbackData: 'map:default:rts' }), deps);
    expect(rcon.map).toHaveBeenCalledWith('rts');
  });
});
