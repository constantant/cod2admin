import { describe, expect, it, vi } from 'vitest';
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

  it('splits files with Windows line endings too', () => {
    expect(splitForTelegram('aaaa\r\n\r\nbbbb\r\n\r\ncccc', 11)).toEqual(['aaaa\n\nbbbb', 'cccc']);
  });
});

/**
 * Telegram's legacy Markdown rejects the whole message on one unbalanced `_` or `*` — e.g. an
 * italic line containing a link to `.../lists_vpn` broke /help from v1.7.0 to v1.9.0. This checks
 * what Telegram checks: outside code spans, bold/italic markers pair up, and link URLs hold none.
 */
function markdownProblems(chunk: string): string[] {
  const problems: string[] = [];
  const withoutCode = chunk.replace(/`[^`\n]*`/g, '');
  for (const [, url] of withoutCode.matchAll(/\]\(([^)]*)\)/g)) {
    if (/[_*]/.test(url!)) {
      problems.push(`link URL with _ or *: ${url}`);
    }
  }
  const plain = withoutCode.replace(/\]\([^)]*\)/g, ']');
  for (const marker of ['_', '*']) {
    const count = plain.split(marker).length - 1;
    if (count % 2 !== 0) {
      problems.push(`odd number of ${marker} (${count})`);
    }
  }
  return problems;
}

describe.each([
  ['English', helpCommand],
  ['Russian', helpRuCommand],
])('the real %s help file', (_language, command) => {
  it('goes out in chunks Telegram accepts: under the length limit, with balanced Markdown', async () => {
    const ctx = createFakeCtx();

    await command(ctx);

    const chunks = vi.mocked(ctx.reply).mock.calls.map(([text]) => text);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect(chunk).not.toContain('\r');
      expect(markdownProblems(chunk)).toEqual([]);
    }
  });
});

describe('markdownProblems', () => {
  it('catches the v1.7.0 credits line that broke /help', () => {
    expect(markdownProblems('_VPN ranges by [X4BNet](https://github.com/X4BNet/lists_vpn)._')).toContain(
      'link URL with _ or *: https://github.com/X4BNet/lists_vpn',
    );
    expect(markdownProblems('`/vpn_nets` and *bold* and _italic_')).toEqual([]);
    expect(markdownProblems('a stray _ here')).toEqual(['odd number of _ (1)']);
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
