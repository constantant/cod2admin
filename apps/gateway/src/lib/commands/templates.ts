import { matchText, type BotContext } from '../bot-context.js';
import {
  applyChatTemplates,
  CHAT_TEMPLATE_IDS,
  CHAT_TEMPLATES_SETTING_KEY,
  DEFAULT_CHAT_TEMPLATES,
  isChatTemplateId,
  type ChatTemplateId,
  type ChatTemplateMap,
} from '../chat-templates.js';
import type { GatewayDeps } from '../deps.js';

export const TEMPLATES_USAGE = [
  '/templates — the lines the bot sends into the game',
  '/templates set <id> <text>',
  '/templates clear <id> — send nothing',
  '/templates reset <id> — the built-in line',
  `ids: ${CHAT_TEMPLATE_IDS.join(', ')}`,
  'Placeholders: {name} {reason} {kind} {minutes}. A typed /say is not one of these.',
].join('\n');

function formatList(templates: ChatTemplateMap): string {
  const lines = CHAT_TEMPLATE_IDS.map((id) => {
    const where = id === 'mute_warn' ? 'private' : 'everyone';
    const text = templates[id] || '(sends nothing)';
    return `${id} (${where}): ${text}`;
  });
  return [...lines, '', TEMPLATES_USAGE].join('\n');
}

async function save(
  ctx: BotContext,
  deps: GatewayDeps,
  next: ChatTemplateMap,
  detail: unknown,
): Promise<void> {
  await deps.adminStore.setSetting(CHAT_TEMPLATES_SETTING_KEY, next);
  deps.chatTemplates.setAll(next);
  await deps.adminStore.recordAuditLog({
    actorTelegramId: ctx.admin!.telegramId,
    action: 'templates',
    target: null,
    source: 'telegram_command',
    detailJson: detail,
  });
}

/**
 * `/templates` — the fixed lines the bot sends into the game (chat-templates.ts).
 * Saved in the database and applied at once. Empty sends nothing.
 */
export async function templatesCommand(
  ctx: BotContext,
  deps: GatewayDeps,
): Promise<void> {
  const text = matchText(ctx);
  const space = text.indexOf(' ');
  const sub = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : text.slice(space + 1).trim();
  const idSpace = rest.indexOf(' ');
  const idRaw = (idSpace === -1 ? rest : rest.slice(0, idSpace)).toLowerCase();
  const body = idSpace === -1 ? '' : rest.slice(idSpace + 1).trim();

  if (!sub) {
    await ctx.reply(formatList(deps.chatTemplates.all));
    return;
  }
  if (!isChatTemplateId(idRaw) || !['set', 'clear', 'reset'].includes(sub)) {
    await ctx.reply(TEMPLATES_USAGE);
    return;
  }
  const id: ChatTemplateId = idRaw;
  if (sub === 'set' && !body) {
    await ctx.reply(`Usage: /templates set ${id} <text>`);
    return;
  }
  const raw =
    sub === 'clear' ? '' : sub === 'reset' ? DEFAULT_CHAT_TEMPLATES[id] : body;
  const next = applyChatTemplates(deps.chatTemplates.all, { [id]: raw });
  await save(ctx, deps, next, { id, text: next[id] });
  await ctx.reply(`${id}: ${next[id] || '(sends nothing)'}`);
}
