/**
 * Structural subset of grammy's `Context` that command handlers actually use. Handlers accept
 * this instead of grammy's `Context` so tests can pass a plain fake object (per docs/PLAN.md
 * §11.2 — "grammy supports constructing fake Context/Update objects directly", but a plain
 * object satisfying this interface is simpler still) instead of a real bot/API instance.
 */
export interface BotContext {
  from?: { id: number; username?: string };
  /** Text following the command name, e.g. "12 griefing" for "/kick 12 griefing". */
  match?: string | number | RegExpMatchArray;
  reply(text: string, other?: unknown): Promise<unknown>;
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
