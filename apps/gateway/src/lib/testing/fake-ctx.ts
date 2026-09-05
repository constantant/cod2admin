import { vi } from 'vitest';
import type { BotContext } from '../bot-context.js';
import type { EditableBotContext } from '../commands/status.js';

export function createFakeCtx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    from: { id: 1 },
    match: '',
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function createFakeEditableCtx(overrides: Partial<EditableBotContext> = {}): EditableBotContext {
  return {
    from: { id: 1 },
    match: '',
    reply: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
