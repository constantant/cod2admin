import type { ChatEvent, ReportTrigger } from '@cod2admin/log-tailer';
import type { ReportAntiSpam } from '@cod2admin/report-pipeline';
import { ReportAntiSpam as RealReportAntiSpam } from '@cod2admin/report-pipeline';
import type { StatusPlayer } from '@cod2admin/rcon-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModerationActionError } from './moderation-actions.js';
import {
  decodeCallbackData,
  GatewayCardSender,
  handleReportTrigger,
  reportActionCallback,
  ReportRegistry,
  type ReportCallbackContext,
  type ReportCallbackDeps,
} from './reports.js';
import { createFakeDeps } from './testing/fake-deps.js';

vi.mock('./moderation-actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./moderation-actions.js')>();
  return { ...actual, executeModerationAction: vi.fn() };
});
const { executeModerationAction } = await import('./moderation-actions.js');

function chatEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    channel: 'say',
    guid: '0',
    num: 9,
    name: 'Reporter',
    message: '!report Cheatr123 aimbot',
    timestamp: { minutes: 1, seconds: 0 },
    raw: '',
    ...overrides,
  };
}

function trigger(overrides: Partial<ReportTrigger> = {}): ReportTrigger {
  return { chat: chatEvent(), targetName: 'Cheatr123', reason: 'aimbot', ...overrides };
}

function statusPlayer(overrides: Partial<StatusPlayer> = {}): StatusPlayer {
  return { num: 1, score: 0, ping: 40, name: 'Cheatr123', ...overrides };
}

function createFakeBot() {
  let nextMessageId = 1;
  return {
    api: {
      sendMessage: vi.fn(async () => ({ message_id: nextMessageId++ })),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createFakeCallbackCtx(overrides: Partial<ReportCallbackContext> = {}): ReportCallbackContext {
  return {
    from: { id: 1 },
    admin: { telegramId: 1, role: 'admin' },
    callbackData: '',
    editMessageText: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('decodeCallbackData', () => {
  it('decodes a simple action', () => {
    expect(decodeCallbackData('report:3:kick')).toEqual({ reportId: '3', action: { kind: 'kick' } });
  });

  it('decodes a select action with its candidate number', () => {
    expect(decodeCallbackData('report:3:select:7')).toEqual({ reportId: '3', action: { kind: 'select', candidateNum: 7 } });
  });

  it('returns null for anything not shaped like ours', () => {
    expect(decodeCallbackData('status:refresh')).toBeNull();
    expect(decodeCallbackData('report:')).toBeNull();
    expect(decodeCallbackData('report:3:not-a-real-action')).toBeNull();
    expect(decodeCallbackData('report:3:select:not-a-number')).toBeNull();
  });
});

describe('ReportRegistry', () => {
  it('reserves monotonically increasing ids and round-trips entries', () => {
    const registry = new ReportRegistry();
    const id1 = registry.reserveId();
    const id2 = registry.reserveId();
    expect(id1).not.toBe(id2);

    registry.set(id1, { chatId: 1, messageId: 1, serverAlias: 'default', trigger: trigger() });
    expect(registry.get(id1)).toMatchObject({ chatId: 1, messageId: 1 });
    expect(registry.get(id2)).toBeUndefined();

    registry.delete(id1);
    expect(registry.get(id1)).toBeUndefined();
  });
});

describe('GatewayCardSender', () => {
  it('send() mints an id, posts via bot.api.sendMessage with a mapped keyboard, and registers the entry', async () => {
    const bot = createFakeBot();
    const registry = new ReportRegistry();
    const sender = new GatewayCardSender(bot as never, registry, 'default', trigger());

    const id = await sender.send(555, {
      text: 'hello',
      buttons: [[{ label: 'Kick', action: { kind: 'kick' } }]],
      detailText: 'full detail',
    });

    expect(bot.api.sendMessage).toHaveBeenCalledWith(555, 'hello', { reply_markup: expect.anything() });
    const entry = registry.get(id);
    expect(entry).toMatchObject({ chatId: 555, serverAlias: 'default', detailText: 'full detail' });
  });

  it('update() edits the registered message and swallows a "message is not modified" error', async () => {
    const bot = createFakeBot();
    const registry = new ReportRegistry();
    const sender = new GatewayCardSender(bot as never, registry, 'default', trigger());
    const id = await sender.send(555, { text: 'hello', buttons: [] });

    await sender.update(id, { text: 'updated', buttons: [] });
    expect(bot.api.editMessageText).toHaveBeenCalledWith(555, 1, 'updated', { reply_markup: expect.anything() });

    bot.api.editMessageText.mockRejectedValueOnce(new Error('Bad Request: message is not modified: blah'));
    await expect(sender.update(id, { text: 'updated', buttons: [] })).resolves.toBeUndefined();
  });

  it('update() is a no-op when the registry has no entry (e.g. gateway restarted)', async () => {
    const bot = createFakeBot();
    const registry = new ReportRegistry();
    const sender = new GatewayCardSender(bot as never, registry, 'default', trigger());

    await sender.update('nonexistent', { text: 'x', buttons: [] });

    expect(bot.api.editMessageText).not.toHaveBeenCalled();
  });
});

describe('handleReportTrigger', () => {
  it('sends a card and stores the resolved action context in the registry', async () => {
    const bot = createFakeBot();
    const registry = new ReportRegistry();
    const antiSpam = new RealReportAntiSpam<string>({ now: () => 0 });
    const { deps } = createFakeDeps();
    deps.rconClients.get('default')!.status = vi.fn().mockResolvedValue({ raw: '', players: [statusPlayer({ guid: 'realguid', ip: '1.2.3.4' })] });

    await handleReportTrigger(trigger(), {
      bot: bot as never,
      registry,
      antiSpam,
      serverAlias: 'default',
      chatId: 999,
      rcon: deps.rconClients.get('default')!,
      sessions: { getSession: () => undefined, listSessions: () => [] },
      adminStore: deps.adminStore,
      banStore: deps.banStore,
    });

    expect(bot.api.sendMessage).toHaveBeenCalledOnce();
    const entry = registry.get('1');
    expect(entry?.context).toEqual({ serverAlias: 'default', targetNum: 1, targetName: 'Cheatr123', targetGuid: 'realguid', targetIp: '1.2.3.4' });
  });
});

describe('reportActionCallback', () => {
  beforeEach(() => {
    vi.mocked(executeModerationAction).mockReset();
  });

  function baseDeps(overrides: Partial<ReportCallbackDeps> = {}): { deps: ReportCallbackDeps; bot: ReturnType<typeof createFakeBot>; registry: ReportRegistry; antiSpam: ReportAntiSpam<string> } {
    const bot = createFakeBot();
    const registry = new ReportRegistry();
    const antiSpam = new RealReportAntiSpam<string>({ now: () => 0 });
    const { deps: gatewayDeps } = createFakeDeps();
    const deps: ReportCallbackDeps = {
      bot: bot as never,
      registry,
      antiSpam,
      rconClients: gatewayDeps.rconClients,
      adminStore: gatewayDeps.adminStore,
      banStore: gatewayDeps.banStore,
      sessionsByServer: new Map(),
      ...overrides,
    };
    return { deps, bot, registry, antiSpam };
  }

  it('answers with an error for unrecognized callback data', async () => {
    const { deps } = baseDeps();
    const ctx = createFakeCallbackCtx({ callbackData: 'not-ours' });

    await reportActionCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Unrecognized') }));
  });

  it('answers with an expiry notice when the report id is not in the registry', async () => {
    const { deps } = baseDeps();
    const ctx = createFakeCallbackCtx({ callbackData: 'report:99:kick' });

    await reportActionCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('expired') }));
  });

  it('refuses when the caller has no admin record', async () => {
    const { deps, registry } = baseDeps();
    registry.set('1', { chatId: 1, messageId: 1, serverAlias: 'default', trigger: trigger() });
    const ctx = createFakeCallbackCtx({ admin: undefined, callbackData: 'report:1:kick' });

    await reportActionCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'Not authorized.' }));
    expect(executeModerationAction).not.toHaveBeenCalled();
  });

  it('requires the admin role for Ban (moderator is refused)', async () => {
    const { deps, registry } = baseDeps();
    registry.set('1', {
      chatId: 1,
      messageId: 1,
      serverAlias: 'default',
      trigger: trigger(),
      context: { serverAlias: 'default', targetNum: 1, targetName: 'Cheatr123', targetGuid: 'realguid' },
    });
    const ctx = createFakeCallbackCtx({ admin: { telegramId: 1, role: 'moderator' }, callbackData: 'report:1:ban' });

    await reportActionCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Admin role required') }));
    expect(executeModerationAction).not.toHaveBeenCalled();
  });

  it('allows a moderator to kick', async () => {
    vi.mocked(executeModerationAction).mockResolvedValue({ label: 'Kicked', ipFallback: false });
    const { deps, registry, antiSpam } = baseDeps();
    registry.set('1', {
      chatId: 1,
      messageId: 1,
      serverAlias: 'default',
      trigger: trigger(),
      context: { serverAlias: 'default', targetNum: 1, targetName: 'Cheatr123' },
    });
    const ctx = createFakeCallbackCtx({ admin: { telegramId: 1, role: 'moderator' }, callbackData: 'report:1:kick' });

    await reportActionCallback(ctx, deps);

    expect(executeModerationAction).toHaveBeenCalledWith('kick', expect.objectContaining({ num: 1, name: 'Cheatr123' }), expect.objectContaining({ source: 'telegram_button' }));
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Kicked Cheatr123'));
    expect(registry.get('1')).toBeUndefined();
    expect(antiSpam.check(9, 'Cheatr123')).toEqual({ allowed: true, reason: 'fresh' });
  });

  it('answers with the ModerationActionError message instead of throwing', async () => {
    vi.mocked(executeModerationAction).mockRejectedValue(new ModerationActionError('no guid and no ip'));
    const { deps, registry } = baseDeps();
    registry.set('1', {
      chatId: 1,
      messageId: 1,
      serverAlias: 'default',
      trigger: trigger(),
      context: { serverAlias: 'default', targetNum: 1, targetName: 'Cheatr123' },
    });
    const ctx = createFakeCallbackCtx({ callbackData: 'report:1:ban' });

    await expect(reportActionCallback(ctx, deps)).resolves.toBeUndefined();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: 'no guid and no ip' }));
  });

  it('re-throws a non-ModerationActionError from executeModerationAction', async () => {
    vi.mocked(executeModerationAction).mockRejectedValue(new Error('network blip'));
    const { deps, registry } = baseDeps();
    registry.set('1', {
      chatId: 1,
      messageId: 1,
      serverAlias: 'default',
      trigger: trigger(),
      context: { serverAlias: 'default', targetNum: 1, targetName: 'Cheatr123' },
    });
    const ctx = createFakeCallbackCtx({ callbackData: 'report:1:kick' });

    await expect(reportActionCallback(ctx, deps)).rejects.toThrow('network blip');
  });

  it('answers with an alert when there is no resolved context yet (ambiguous/not-found card)', async () => {
    const { deps, registry } = baseDeps();
    registry.set('1', { chatId: 1, messageId: 1, serverAlias: 'default', trigger: trigger() });
    const ctx = createFakeCallbackCtx({ callbackData: 'report:1:kick' });

    await reportActionCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('No resolved target') }));
    expect(executeModerationAction).not.toHaveBeenCalled();
  });

  it('ignore edits the message, resolves anti-spam, and drops the registry entry', async () => {
    const { deps, registry, antiSpam } = baseDeps();
    antiSpam.track(9, 'Cheatr123', '1');
    registry.set('1', { chatId: 1, messageId: 1, serverAlias: 'default', trigger: trigger() });
    const ctx = createFakeCallbackCtx({ callbackData: 'report:1:ignore' });

    await reportActionCallback(ctx, deps);

    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('ignored'));
    expect(registry.get('1')).toBeUndefined();
    // resolve() clears the dedup collapse (a later report won't fold into the ignored card) -
    // it does not reset the reporter's cooldown clock, so this can still legitimately be 'cooldown'.
    expect(antiSpam.check(9, 'Cheatr123').reason).not.toBe('duplicate');
  });

  it('more-info answers with the stored detail text as an alert, without editing the message', async () => {
    const { deps, registry } = baseDeps();
    registry.set('1', { chatId: 1, messageId: 1, serverAlias: 'default', trigger: trigger(), detailText: 'full chat history here' });
    const ctx = createFakeCallbackCtx({ callbackData: 'report:1:more-info' });

    await reportActionCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'full chat history here', show_alert: true });
    expect(ctx.editMessageText).not.toHaveBeenCalled();
  });

  it('select re-resolves the chosen candidate, updates the card, and sets the action context', async () => {
    const { deps, registry, bot } = baseDeps();
    registry.set('1', { chatId: 1, messageId: 1, serverAlias: 'default', trigger: trigger() });
    deps.rconClients.get('default')!.status = vi.fn().mockResolvedValue({ raw: '', players: [statusPlayer({ num: 7, name: 'Cheatr123Real', guid: 'realguid' })] });
    const ctx = createFakeCallbackCtx({ callbackData: 'report:1:select:7' });

    await reportActionCallback(ctx, deps);

    expect(bot.api.editMessageText).toHaveBeenCalled();
    expect(registry.get('1')?.context).toEqual({ serverAlias: 'default', targetNum: 7, targetName: 'Cheatr123Real', targetGuid: 'realguid', targetIp: undefined });
  });

  it('select answers with an alert when the chosen candidate is no longer connected', async () => {
    const { deps, registry, bot } = baseDeps();
    registry.set('1', { chatId: 1, messageId: 1, serverAlias: 'default', trigger: trigger() });
    deps.rconClients.get('default')!.status = vi.fn().mockResolvedValue({ raw: '', players: [] });
    const ctx = createFakeCallbackCtx({ callbackData: 'report:1:select:7' });

    await reportActionCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('no longer connected') }));
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
  });

  it('answers with an error when the server is no longer configured', async () => {
    const { deps, registry } = baseDeps();
    registry.set('1', { chatId: 1, messageId: 1, serverAlias: 'gone', trigger: trigger() });
    const ctx = createFakeCallbackCtx({ callbackData: 'report:1:kick' });

    await reportActionCallback(ctx, deps);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('no longer configured') }));
  });
});
