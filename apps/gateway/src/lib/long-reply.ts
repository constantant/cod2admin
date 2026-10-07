import { InputFile } from 'grammy';
import type { BotContext } from './bot-context.js';
import { getRunningVersion } from './version.js';

/**
 * Replies that can outgrow a Telegram message. Short ones are sent as one plain message, as
 * before. Long ones become a short summary plus the full report attached as a Markdown file —
 * Telegram rejects messages over 4096 characters outright, and a full 40-player `/players` with
 * country, city, provider and VPN labels lands right at that limit (measured 2026-10-07).
 */

/** Telegram's hard limit for one message's text. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
/** Telegram's limit for a document's caption — a longer summary goes in its own message. */
const CAPTION_LIMIT = 1024;
/** Above either of these the reply is "long": summary + attached report instead. */
export const INLINE_MAX_LINES = 12;
export const INLINE_MAX_CHARS = 1500;

export interface LongReply {
  /** What's sent when it's short — today's plain message. */
  full: string;
  /** What's sent instead when it's long, with the file. */
  summary: string;
  /** The attached report. */
  markdown: string;
  /** e.g. `players-ctfrussia-2026-10-07-1023.md`. */
  fileName: string;
}

export function fitsInline(text: string): boolean {
  return text.length <= INLINE_MAX_CHARS && text.split('\n').length <= INLINE_MAX_LINES;
}

/** Cuts text to `limit` characters on a line boundary where possible, marking the cut. */
export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const marker = '\n…';
  const cut = text.slice(0, limit - marker.length);
  const lastNewline = cut.lastIndexOf('\n');
  return (lastNewline > limit / 2 ? cut.slice(0, lastNewline) : cut) + marker;
}

export async function replyWithReport(ctx: BotContext, reply: LongReply): Promise<void> {
  if (fitsInline(reply.full)) {
    await ctx.reply(reply.full);
    return;
  }
  const summary = truncateText(reply.summary, TELEGRAM_MESSAGE_LIMIT);
  if (!ctx.replyWithDocument) {
    await ctx.reply(summary);
    return;
  }
  const file = new InputFile(Buffer.from(reply.markdown, 'utf8'), reply.fileName);
  if (summary.length <= CAPTION_LIMIT) {
    await ctx.replyWithDocument(file, { caption: summary });
  } else {
    await ctx.reply(summary);
    await ctx.replyWithDocument(file);
  }
}

/** `players-ctfrussia-2026-10-07-1023.md` — UTC, safe on every filesystem. */
export function reportFileName(kind: string, scope: string | undefined, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const safeScope = scope?.replace(/[^A-Za-z0-9_-]+/g, '_');
  return `${[kind, safeScope, stamp].filter(Boolean).join('-')}.md`;
}

/** Makes text safe inside a Markdown table cell: no pipes, line breaks or stray backticks. */
export function markdownCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/`/g, "'")
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export function markdownTable(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`),
  ].join('\n');
}

/** A fenced code block that can't be closed early by backticks inside `text`. */
export function markdownCodeBlock(text: string): string {
  const longestRun = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}\n${text}\n${fence}`;
}

export interface ReportDocumentOptions {
  title: string;
  /** Lines under the title, e.g. server and map. */
  meta?: string[];
  body: string;
  now: Date;
  /** Data-source credits, when the report shows IP locations or VPN flags. */
  credits?: boolean;
}

/** Title, meta, body and a footer saying when and by which bot version it was made. */
export function reportDocument(options: ReportDocumentOptions): string {
  const generated = `${options.now.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const lines = [`# ${options.title}`, '', ...(options.meta ?? []).map((line) => `- ${line}`)];
  lines.push(`- Generated: ${generated} by cod2admin v${safeVersion()}`, '', options.body.trimEnd(), '');
  if (options.credits) {
    lines.push(
      '---',
      '',
      '_IP location and provider data by DB-IP.com (CC BY 4.0). VPN ranges by X4BNet, Tor exits by the Tor Project._',
      '',
    );
  }
  return lines.join('\n');
}

function safeVersion(): string {
  try {
    return getRunningVersion();
  } catch {
    return 'unknown';
  }
}
