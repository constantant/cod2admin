import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AdminRole } from '@cod2admin/admin-store';
import { InputFile } from 'grammy';
import type { BotContext } from '../bot-context.js';
import type { GatewayDeps } from '../deps.js';

/**
 * `/help` and `/help_ru`: a short message with only the commands the caller's role uses most, and
 * the full guide (docs/BOT-HELP*.md) attached as a Markdown file. Until v1.9.1 the whole guide was
 * sent as chat messages — two long ones by then, too much to scroll past in a group.
 *
 * The guides live as real .md files, not inline strings — same reasoning as admin-store/ban-store
 * shipping their drizzle migrations alongside dist (docs/PLAN.md's "resolve relative to package
 * root" pattern): editable without touching command code, and readable as plain docs outside
 * Telegram. scripts/build-installer-bundle.sh copies this docs/ folder into the deployable bundle.
 */
const HELP_EN_PATH = fileURLToPath(new URL('../../../docs/BOT-HELP.md', import.meta.url));
const HELP_RU_PATH = fileURLToPath(new URL('../../../docs/BOT-HELP-ru.md', import.meta.url));

export type HelpLanguage = 'en' | 'ru';
/** `player` — anyone without a role: they only need `!report`. */
export type HelpAudience = AdminRole | 'player';

const ROLE_RANK: Record<HelpAudience, number> = { player: 0, moderator: 1, admin: 2, owner: 3 };

interface HelpLine {
  minRole: HelpAudience;
  en: string;
  ru: string;
}

/** The most-used commands, cheapest role first. Everything else is in the attached guide. */
const SHORT_HELP_LINES: readonly HelpLine[] = [
  { minRole: 'moderator', en: '/status — server, map, player count', ru: '/status — сервер, карта, число игроков' },
  {
    minRole: 'moderator',
    en: '/players — who is on, with country and 🛡 VPN marks',
    ru: '/players — кто играет, страна и метка 🛡 VPN',
  },
  { minRole: 'moderator', en: '/kick <id or name>', ru: '/kick <id или имя>' },
  {
    minRole: 'moderator',
    en: '/tempban <id> [30m|2h|7d] [reason]',
    ru: '/tempban <id> [30m|2h|7d] [причина]',
  },
  { minRole: 'admin', en: '/ban <id> [reason] — permanent', ru: '/ban <id> [причина] — навсегда' },
  { minRole: 'admin', en: '/unban <guid or ip>, /bans — active bans', ru: '/unban <guid или ip>, /bans — активные баны' },
  { minRole: 'admin', en: '/maps — switch map with buttons', ru: '/maps — смена карты кнопками' },
  { minRole: 'admin', en: '/say <message> — to the game chat', ru: '/say <сообщение> — в игровой чат' },
  { minRole: 'owner', en: '/auditlog [n] — who did what', ru: '/auditlog [n] — кто что делал' },
  { minRole: 'owner', en: '/update — install a new bot version', ru: '/update — поставить новую версию бота' },
];

const TEXT = {
  en: {
    title: (audience: HelpAudience) => (audience === 'player' ? 'cod2admin bot' : `cod2admin bot — your role: ${audience}`),
    report: [
      'Report a player from the in-game chat:',
      '!report <name> <reason>  e.g. !report Cheatr123 aimbot',
      'Part of the name is enough. Admins get the report here.',
    ],
    reportShort: 'In-game: !report <name> <reason>',
    serverFlag: 'Add --server <alias> to pick a server (/servers).',
    footer: 'Full guide: attached file. /help_ru — по-русски.',
    fileName: 'cod2admin-help.md',
  },
  ru: {
    title: (audience: HelpAudience) => (audience === 'player' ? 'cod2admin бот' : `cod2admin бот — ваша роль: ${audience}`),
    report: [
      'Пожаловаться на игрока из игрового чата:',
      '!report <имя> <причина>  например !report Cheatr123 aimbot',
      'Достаточно части имени. Жалоба придёт админам сюда.',
    ],
    reportShort: 'В игре: !report <имя> <причина>',
    serverFlag: 'Добавьте --server <алиас>, чтобы выбрать сервер (/servers).',
    footer: 'Полная инструкция — в файле. /help — in English.',
    fileName: 'cod2admin-help-ru.md',
  },
} as const;

/** The short `/help` text for one role — plain text, no Markdown, so Telegram can't reject it. */
export function formatShortHelp(audience: HelpAudience, language: HelpLanguage): string {
  const text = TEXT[language];
  if (audience === 'player') {
    return [text.title(audience), '', ...text.report, '', text.footer].join('\n');
  }
  const commands = SHORT_HELP_LINES.filter((line) => ROLE_RANK[line.minRole] <= ROLE_RANK[audience]).map(
    (line) => line[language],
  );
  return [text.title(audience), '', ...commands, text.reportShort, '', text.serverFlag, text.footer].join('\n');
}

async function sendHelp(ctx: BotContext, deps: Pick<GatewayDeps, 'adminStore'>, language: HelpLanguage): Promise<void> {
  const telegramId = ctx.from?.id;
  const admin = telegramId === undefined ? undefined : await deps.adminStore.getAdmin(telegramId);
  const short = formatShortHelp(admin?.role ?? 'player', language);
  if (!ctx.replyWithDocument) {
    await ctx.reply(short);
    return;
  }
  const guide = readFileSync(language === 'en' ? HELP_EN_PATH : HELP_RU_PATH, 'utf-8').replace(/\r\n/g, '\n');
  await ctx.replyWithDocument(new InputFile(Buffer.from(guide, 'utf8'), TEXT[language].fileName), { caption: short });
}

/** `/help` — no role gate (players need it for !report); the short part depends on the caller's role. */
export async function helpCommand(ctx: BotContext, deps: Pick<GatewayDeps, 'adminStore'>): Promise<void> {
  await sendHelp(ctx, deps, 'en');
}

/** `/help_ru` — Russian counterpart (docs/BOT-HELP-ru.md). */
export async function helpRuCommand(ctx: BotContext, deps: Pick<GatewayDeps, 'adminStore'>): Promise<void> {
  await sendHelp(ctx, deps, 'ru');
}
