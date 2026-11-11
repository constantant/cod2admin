import { sanitizeRconArg } from './sanitize.js';

/**
 * The lines the bot itself sends into the game. A typed `/say` is not one of these.
 * An empty template sends nothing. `vpn_kick` and `known_kick` start empty (issue #10): the console
 * line in the game chat stays off until someone writes it.
 * Stored as one JSON object under `chat.templates`. A missing key keeps the built-in text.
 */
export const CHAT_TEMPLATES_SETTING_KEY = 'chat.templates';

export const CHAT_TEMPLATE_IDS = [
  'kick',
  'watch_kick',
  'ban',
  'tempban',
  'vpn_kick',
  'known_kick',
  'mute_warn',
] as const;

export type ChatTemplateId = (typeof CHAT_TEMPLATE_IDS)[number];

export type ChatTemplateMap = Record<ChatTemplateId, string>;

export const DEFAULT_CHAT_TEMPLATES: ChatTemplateMap = {
  kick: '{name} was kicked by an admin',
  watch_kick: '{name} was kicked',
  ban: '{name} was banned by an admin',
  tempban: '{name} was temp-banned by an admin',
  vpn_kick: '',
  known_kick: '',
  mute_warn:
    'You are muted by an admin. Your next message will get you kicked.',
};

/** What a line may contain. An empty value is left out of the sentence. */
export interface ChatTemplateVars {
  name?: string;
  reason?: string;
  kind?: string;
  minutes?: string;
}

const TOKEN = /\{(name|reason|kind|minutes)\}/g;

const SAMPLE: ChatTemplateVars = {
  name: 'Player',
  reason: 'aimbot',
  kind: 'VPN',
  minutes: '30',
};

const LINE_META: Record<
  ChatTemplateId,
  { channel: 'say' | 'tell'; placeholders: string }
> = {
  kick: { channel: 'say', placeholders: '{name} {reason}' },
  watch_kick: { channel: 'say', placeholders: '{name}' },
  ban: { channel: 'say', placeholders: '{name} {reason}' },
  tempban: {
    channel: 'say',
    placeholders: '{name} {reason} {minutes}',
  },
  vpn_kick: { channel: 'say', placeholders: '{name} {kind}' },
  known_kick: { channel: 'say', placeholders: '{name}' },
  mute_warn: { channel: 'tell', placeholders: '{name}' },
};

export interface ChatTemplateLine {
  id: ChatTemplateId;
  channel: 'say' | 'tell';
  placeholders: string;
  text: string;
  defaultText: string;
  /** What the sample player would see. Empty when the line sends nothing. */
  preview: string;
}

export function isChatTemplateId(value: string): value is ChatTemplateId {
  return (CHAT_TEMPLATE_IDS as readonly string[]).includes(value);
}

/**
 * Fills `{name}`, `{reason}`, `{kind}` and `{minutes}`. Any other `{token}` is left
 * as written. Each value is sanitized before it is inserted, and the finished line
 * is cut to an rcon argument (128). An empty template, or one that renders empty,
 * returns `''` — the caller sends nothing.
 */
export function renderChatTemplate(
  template: string,
  vars: ChatTemplateVars,
): string {
  const values: Record<string, string> = {
    name: sanitizeRconArg(vars.name ?? ''),
    reason: sanitizeRconArg(vars.reason ?? ''),
    kind: sanitizeRconArg(vars.kind ?? ''),
    minutes: sanitizeRconArg(vars.minutes ?? ''),
  };
  const text = template
    .replace(TOKEN, (_match, key: string) => values[key] ?? '')
    .replace(/[ \t]{2,}/g, ' ');
  return sanitizeRconArg(text);
}

/** A stored object. Unknown keys are ignored. A non-string value keeps the default. */
export function parseChatTemplates(value: unknown): ChatTemplateMap {
  const stored =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const result: ChatTemplateMap = { ...DEFAULT_CHAT_TEMPLATES };
  for (const id of CHAT_TEMPLATE_IDS) {
    const raw = stored[id];
    if (typeof raw === 'string') {
      result[id] = sanitizeRconArg(raw);
    }
  }
  return result;
}

/** Copies `current` and replaces the ids whose patch value is a string. */
export function applyChatTemplates(
  current: ChatTemplateMap,
  patch: Partial<Record<ChatTemplateId, unknown>>,
): ChatTemplateMap {
  const next: ChatTemplateMap = { ...current };
  for (const id of CHAT_TEMPLATE_IDS) {
    const raw = patch[id];
    if (typeof raw === 'string') {
      next[id] = sanitizeRconArg(raw);
    }
  }
  return next;
}

export function chatTemplateLines(
  templates: ChatTemplateMap,
): ChatTemplateLine[] {
  return CHAT_TEMPLATE_IDS.map((id) => ({
    id,
    channel: LINE_META[id].channel,
    placeholders: LINE_META[id].placeholders,
    text: templates[id],
    defaultText: DEFAULT_CHAT_TEMPLATES[id],
    preview: renderChatTemplate(templates[id], SAMPLE),
  }));
}

/** The live lines. One per gateway, same shape as `VpnKicker`. */
export class ChatTemplates {
  private current: ChatTemplateMap = { ...DEFAULT_CHAT_TEMPLATES };

  get all(): ChatTemplateMap {
    return { ...this.current };
  }

  get(id: ChatTemplateId): string {
    return this.current[id];
  }

  setAll(templates: ChatTemplateMap): void {
    this.current = { ...templates };
  }

  render(id: ChatTemplateId, vars: ChatTemplateVars): string {
    return renderChatTemplate(this.current[id], vars);
  }
}
