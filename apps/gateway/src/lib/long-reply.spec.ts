import { InputFile } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import {
  fitsInline,
  markdownCell,
  markdownCodeBlock,
  markdownTable,
  replyWithReport,
  reportDocument,
  reportFileName,
  truncateText,
  type LongReply,
} from './long-reply.js';
import { createFakeCtx } from './testing/fake-ctx.js';

const NOW = new Date('2026-10-07T10:23:45Z');

function longReply(full: string, summary = 'short summary'): LongReply {
  return { full, summary, markdown: '# Report\n', fileName: 'players-ctfrussia-2026-10-07-1023.md' };
}

describe('replyWithReport', () => {
  it('sends a short reply as one plain message, with no file', async () => {
    const ctx = createFakeCtx();

    await replyWithReport(ctx, longReply('line 1\nline 2'));

    expect(ctx.reply).toHaveBeenCalledWith('line 1\nline 2');
    expect(ctx.replyWithDocument).not.toHaveBeenCalled();
  });

  it('sends a long reply as the summary captioning the attached report', async () => {
    const ctx = createFakeCtx();

    await replyWithReport(ctx, longReply(Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n')));

    expect(ctx.reply).not.toHaveBeenCalled();
    const [file, other] = vi.mocked(ctx.replyWithDocument!).mock.calls[0]!;
    expect(file).toBeInstanceOf(InputFile);
    expect((file as InputFile).filename).toBe('players-ctfrussia-2026-10-07-1023.md');
    expect(other).toEqual({ caption: 'short summary' });
  });

  it('sends a summary too long for a caption as its own message, then the file', async () => {
    const ctx = createFakeCtx();
    const summary = 'x'.repeat(1100);

    await replyWithReport(ctx, longReply('y'.repeat(2000), summary));

    expect(ctx.reply).toHaveBeenCalledWith(summary);
    expect(vi.mocked(ctx.replyWithDocument!).mock.calls[0]![1]).toBeUndefined();
  });

  it('never sends a message over the Telegram limit, and falls back to the summary without file support', async () => {
    const ctx = createFakeCtx({ replyWithDocument: undefined });

    await replyWithReport(ctx, longReply('y'.repeat(9000), 'line\n'.repeat(2000)));

    const sent = vi.mocked(ctx.reply).mock.calls[0]![0];
    expect(sent.length).toBeLessThanOrEqual(4096);
    expect(sent.endsWith('…')).toBe(true);
  });
});

describe('helpers', () => {
  it('decides what fits inline by lines and characters', () => {
    expect(fitsInline(Array.from({ length: 12 }, () => 'a').join('\n'))).toBe(true);
    expect(fitsInline(Array.from({ length: 13 }, () => 'a').join('\n'))).toBe(false);
    expect(fitsInline('a'.repeat(1501))).toBe(false);
  });

  it('cuts text on a line boundary', () => {
    expect(truncateText('aaaa\nbbbb\ncccc', 12)).toBe('aaaa\nbbbb\n…');
    expect(truncateText('short', 12)).toBe('short');
  });

  it('names files by kind, scope and UTC minute', () => {
    expect(reportFileName('players', 'ctf russia/2', NOW)).toBe('players-ctf_russia_2-2026-10-07-1023.md');
    expect(reportFileName('bans', undefined, NOW)).toBe('bans-2026-10-07-1023.md');
  });

  it('keeps table cells from breaking the table', () => {
    expect(markdownCell('a|b`c\nd')).toBe("a\\|b'c d");
    expect(markdownCell(undefined)).toBe('—');
    expect(markdownCell('Игрок')).toBe('Игрок');
    expect(markdownTable(['A', 'B'], [[1, 'x|y']])).toBe('| A | B |\n| --- | --- |\n| 1 | x\\|y |');
  });

  it('fences code with more backticks than it contains', () => {
    expect(markdownCodeBlock('plain')).toBe('```\nplain\n```');
    expect(markdownCodeBlock('has ```` inside')).toBe('`````\nhas ```` inside\n`````');
  });

  it('wraps a report with title, meta, time, version and optional credits', () => {
    const doc = reportDocument({ title: 'Players', meta: ['Server: ctfrussia'], body: 'body', now: NOW, credits: true });

    expect(doc).toContain('# Players\n\n- Server: ctfrussia\n- Generated: 2026-10-07 10:23 UTC by cod2admin v');
    expect(doc).toContain('\nbody\n');
    expect(doc).toContain('DB-IP.com (CC BY 4.0)');
    expect(reportDocument({ title: 'T', body: 'b', now: NOW })).not.toContain('DB-IP');
  });
});
