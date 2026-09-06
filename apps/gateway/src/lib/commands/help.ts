import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BotContext } from '../bot-context.js';

/**
 * Content lives as real .md files, not inline strings — same reasoning as admin-store/ban-store
 * shipping their drizzle migrations alongside dist (docs/PLAN.md's "resolve relative to package
 * root" pattern): editable without touching command code, and readable as plain docs outside
 * Telegram. scripts/build-installer-bundle.sh copies this docs/ folder into the deployable
 * bundle the same way it already copies each package's drizzle/ folder.
 */
const HELP_EN_PATH = fileURLToPath(new URL('../../../docs/BOT-HELP.md', import.meta.url));
const HELP_RU_PATH = fileURLToPath(new URL('../../../docs/BOT-HELP-ru.md', import.meta.url));

const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Splits on blank-line paragraph boundaries so a chunk never splits mid-sentence (or mid-Markdown
 * entity) — Telegram rejects anything over 4096 characters outright. Assumes no single paragraph
 * in the source .md files exceeds the limit on its own; keep sections reasonably short.
 */
export function splitForTelegram(text: string, maxLength = TELEGRAM_MESSAGE_LIMIT): string[] {
  const paragraphs = text.split('\n\n');
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

async function sendHelp(ctx: BotContext, path: string): Promise<void> {
  const content = readFileSync(path, 'utf-8');
  for (const chunk of splitForTelegram(content)) {
    await ctx.reply(chunk, { parse_mode: 'Markdown' });
  }
}

/** `/help` — bilingual usage reference (English half); no role gate, players need this for !report. */
export async function helpCommand(ctx: BotContext): Promise<void> {
  await sendHelp(ctx, HELP_EN_PATH);
}

/** `/help_ru` — Russian counterpart (docs/BOT-HELP-ru.md), same content and no role gate. */
export async function helpRuCommand(ctx: BotContext): Promise<void> {
  await sendHelp(ctx, HELP_RU_PATH);
}
