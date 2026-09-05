import { describe, expect, it } from 'vitest';
import { sanitizeRconArg } from './sanitize.js';

describe('sanitizeRconArg', () => {
  it('passes ordinary text through unchanged', () => {
    expect(sanitizeRconArg('griefing teammates')).toBe('griefing teammates');
  });

  it('strips characters that could chain a second console command', () => {
    expect(sanitizeRconArg('hello; banUser 0')).toBe('hello banUser 0');
  });

  it('strips control characters and quotes', () => {
    expect(sanitizeRconArg('line1\nline2\r\0"quoted"')).toBe('line1line2quoted');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeRconArg('  padded  ')).toBe('padded');
  });

  it('truncates to a bounded length', () => {
    const result = sanitizeRconArg('a'.repeat(500));
    expect(result.length).toBe(128);
  });
});
