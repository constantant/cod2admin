import { describe, expect, it } from 'vitest';
import { formatTelegramUser } from './telegram-user.js';

describe('formatTelegramUser', () => {
  it('prefers @username, then first name, always keeping the ID', () => {
    expect(formatTelegramUser(42, 'nick', 'Kostya')).toBe('@nick (42)');
    expect(formatTelegramUser(42, null, 'Kostya')).toBe('Kostya (42)');
    expect(formatTelegramUser(42, null, null)).toBe('42');
  });

  it('names actor 0 as the bot itself, for automatic actions like VPN kicks', () => {
    expect(formatTelegramUser(0, null, null)).toBe('bot (automatic)');
  });
});
