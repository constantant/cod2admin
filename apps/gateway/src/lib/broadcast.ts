import type { RconClient } from '@cod2admin/rcon-client';
import { renderChatTemplate, type ChatTemplateVars } from './chat-templates.js';

/**
 * Says the rendered moderation line in game chat. An empty template, or one that
 * renders empty, sends nothing (chat-templates.ts).
 */
export async function broadcastModerationAction(
  rcon: Pick<RconClient, 'say'>,
  template: string,
  vars: ChatTemplateVars,
): Promise<void> {
  const text = renderChatTemplate(template, vars);
  if (text) {
    await rcon.say(text);
  }
}
