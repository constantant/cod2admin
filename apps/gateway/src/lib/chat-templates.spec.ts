import { describe, expect, it } from 'vitest';
import {
  applyChatTemplates,
  DEFAULT_CHAT_TEMPLATES,
  parseChatTemplates,
  renderChatTemplate,
} from './chat-templates.js';

describe('renderChatTemplate', () => {
  it('fills the known placeholders and leaves an unknown token as written', () => {
    expect(
      renderChatTemplate('{name} was {verb} for {reason} ({minutes}m)', {
        name: 'Player',
        reason: 'aimbot',
        minutes: '30',
      }),
    ).toBe('Player was {verb} for aimbot (30m)');
  });

  it('drops an empty value and the extra space, and strips a breakout from the name', () => {
    expect(
      renderChatTemplate('{name} was kicked for {reason}', {
        name: 'Cheater; say "hi"',
        reason: '',
      }),
    ).toBe('Cheater say hi was kicked for');
  });

  it('sends nothing for an empty template or one that renders empty', () => {
    expect(renderChatTemplate('', { name: 'Player' })).toBe('');
    expect(renderChatTemplate('   ', { name: 'Player' })).toBe('');
    expect(renderChatTemplate('{reason}', { reason: '' })).toBe('');
  });

  it('cuts the finished line to an rcon argument', () => {
    expect(
      renderChatTemplate('{name}', { name: 'a'.repeat(200) }),
    ).toHaveLength(128);
  });
});

describe('parseChatTemplates', () => {
  it('keeps the built-in text for a missing key and an empty string when one was stored', () => {
    expect(parseChatTemplates(undefined).kick).toBe(
      DEFAULT_CHAT_TEMPLATES.kick,
    );
    expect(parseChatTemplates(undefined).vpn_kick).toBe('');
    expect(parseChatTemplates({ vpn_kick: '{name} out', kick: 3 }).kick).toBe(
      DEFAULT_CHAT_TEMPLATES.kick,
    );
    expect(parseChatTemplates({ kick: '' }).kick).toBe('');
  });

  it('applies only the string fields of a patch', () => {
    const next = applyChatTemplates(DEFAULT_CHAT_TEMPLATES, {
      vpn_kick: '{name}: {kind}',
      ban: 1,
    });
    expect(next.vpn_kick).toBe('{name}: {kind}');
    expect(next.ban).toBe(DEFAULT_CHAT_TEMPLATES.ban);
    expect(next.kick).toBe(DEFAULT_CHAT_TEMPLATES.kick);
  });
});
