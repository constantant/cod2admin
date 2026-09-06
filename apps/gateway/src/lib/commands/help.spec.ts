import { describe, expect, it } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { helpCommand, helpRuCommand, splitForTelegram } from './help.js';

describe('splitForTelegram', () => {
  it('returns the whole text as one chunk when it fits', () => {
    expect(splitForTelegram('a\n\nb', 100)).toEqual(['a\n\nb']);
  });

  it('splits on paragraph boundaries once the limit is exceeded', () => {
    expect(splitForTelegram('aaaa\n\nbbbb\n\ncccc', 11)).toEqual(['aaaa\n\nbbbb', 'cccc']);
  });

  it('never drops content, regardless of chunking', () => {
    const text = 'one\n\ntwo\n\nthree\n\nfour';
    expect(splitForTelegram(text, 8).join('\n\n')).toBe(text);
  });
});

describe('helpCommand', () => {
  it('replies with the English help content using Markdown parse mode', async () => {
    const ctx = createFakeCtx();

    await helpCommand(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('!report <name> <reason>'), {
      parse_mode: 'Markdown',
    });
  });
});

describe('helpRuCommand', () => {
  it('replies with the Russian help content using Markdown parse mode', async () => {
    const ctx = createFakeCtx();

    await helpRuCommand(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('!report <имя> <причина>'), {
      parse_mode: 'Markdown',
    });
  });
});
