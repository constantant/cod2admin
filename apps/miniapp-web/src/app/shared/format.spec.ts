import { flagEmoji, formatAgo, formatSpan } from './format';

describe('flagEmoji', () => {
  it('turns an ISO code into a flag, and gives LAN or junk none', () => {
    expect(flagEmoji('RU')).toBe('🇷🇺');
    expect(flagEmoji('LAN')).toBe('');
    expect(flagEmoji(undefined)).toBe('');
  });
});

describe('formatSpan', () => {
  it('shows the two largest units', () => {
    expect(formatSpan(45 * 60_000)).toBe('45m');
    expect(formatSpan(150 * 60_000)).toBe('2h 30m');
    expect(formatSpan(2 * 3_600_000)).toBe('2h');
    expect(formatSpan((3 * 24 + 4) * 3_600_000)).toBe('3d 4h');
    expect(formatSpan(0)).toBe('1m');
  });
});

describe('formatAgo', () => {
  const now = new Date('2026-10-07T12:00:00Z');

  it('is relative for recent times', () => {
    expect(formatAgo('2026-10-07T11:59:30Z', now)).toBe('just now');
    expect(formatAgo('2026-10-07T11:00:00Z', now)).toBe('1h ago');
  });

  it('is a date for anything older than a week', () => {
    expect(formatAgo('2026-09-01T12:00:00Z', now)).toBe(new Date('2026-09-01T12:00:00Z').toLocaleDateString());
  });
});
