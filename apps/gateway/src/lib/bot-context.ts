import type { AdminRole } from '@cod2admin/admin-store';
import type { InputFile } from 'grammy';

/**
 * Structural subset of grammy's `Context` that command handlers actually use. Handlers accept
 * this instead of grammy's `Context` so tests can pass a plain fake object (per docs/PLAN.md
 * §11.2 — "grammy supports constructing fake Context/Update objects directly", but a plain
 * object satisfying this interface is simpler still) instead of a real bot/API instance.
 */
export interface BotContext {
  from?: { id: number; username?: string; first_name?: string };
  /** `type` is "private" | "group" | "supergroup" | "channel" on real updates. */
  chat?: { id: number; type?: string };
  /** Text following the command name, e.g. "12 griefing" for "/kick 12 griefing". */
  match?: string | number | RegExpMatchArray;
  /** The Telegram ID of whoever's message this command replied to, if any (e.g. /addadmin). */
  replyToUserId?: number;
  /** Set by `requireRole` (auth.ts) once the actor is looked up — undefined before that runs. */
  admin?: { telegramId: number; role: AdminRole; username?: string; firstName?: string };
  reply(text: string, other?: unknown): Promise<unknown>;
  /**
   * Sends a file — grammy's `ctx.replyWithDocument()`, used by long-reply.ts for reports. Optional
   * so hand-built contexts can omit it; without it a long reply falls back to its summary.
   */
  replyWithDocument?(document: InputFile, other?: { caption?: string }): Promise<unknown>;
  /** Deletes the message that triggered this update — grammy's `ctx.deleteMessage()`. */
  deleteMessage?(): Promise<unknown>;
}

export function matchText(ctx: BotContext): string {
  const { match } = ctx;
  if (typeof match === 'string') {
    return match.trim();
  }
  if (typeof match === 'number') {
    return String(match);
  }
  return '';
}
