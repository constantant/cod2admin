import { GrammyError, HttpError, type Transformer } from 'grammy';

/**
 * How the bot reaches the Telegram Bot API (docs/PLAN-russia-access.md). Hosts in Russia can't open
 * connections to api.telegram.org, but can reach free edge platforms that relay requests to it
 * (`packages/telegram-relay`). The bot keeps an ordered list of routes — direct first, then relays
 * — sends every request through the current one, and moves to the next when a request fails with
 * a network error. The owner manages the list from Telegram with `/relays`.
 */

export const DIRECT_TELEGRAM_ROOT = 'https://api.telegram.org';

/**
 * Shared relays run for this project on free edge platforms, tried after direct access. Keep in
 * sync with `DEFAULT_TELEGRAM_RELAYS` in installer/install.sh (telegram-routes.spec.ts checks it).
 */
export const DEFAULT_TELEGRAM_RELAYS: readonly string[] = [
  // Deno Deploy first: Russian ISPs cut Cloudflare connections after 16 KB (see bot.ts).
  'https://cod2admin-telegram-relay.cod2admin.deno.net',
  'https://cod2admin-telegram-relay.cod2admin.workers.dev',
];

/** Setting key for route changes made with `/relays` (admin-store `settings`). */
export const ROUTES_SETTING_KEY = 'telegram.routes';

export interface TelegramRouteSettings {
  /** Try api.telegram.org itself first. */
  direct: boolean;
  /** Relay base URLs, tried in order after direct access. */
  relays: string[];
}

export function routesFrom(settings: TelegramRouteSettings): string[] {
  return [...(settings.direct ? [DIRECT_TELEGRAM_ROOT] : []), ...settings.relays];
}

/** `https://x.deno.dev/` → `https://x.deno.dev`; undefined for anything that isn't a plain https URL. */
export function normalizeRelayUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) {
    return undefined;
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Validates a stored `/relays` setting, so a malformed row falls back to the defaults. */
export function parseRouteSettings(value: unknown): TelegramRouteSettings | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { direct, relays } = value as Partial<TelegramRouteSettings>;
  if (typeof direct !== 'boolean' || !Array.isArray(relays)) {
    return undefined;
  }
  const valid = relays.map((relay) => (typeof relay === 'string' ? normalizeRelayUrl(relay) : undefined));
  if (valid.some((relay) => relay === undefined)) {
    return undefined;
  }
  const settings = { direct, relays: valid as string[] };
  return routesFrom(settings).length > 0 ? settings : undefined;
}

export function describeRoute(root: string): string {
  return root === DIRECT_TELEGRAM_ROOT ? 'direct (api.telegram.org)' : root;
}

export class TelegramRouter {
  private routes: string[];
  private index = 0;

  constructor(
    routes: string[],
    private readonly log: (message: string) => void = (message) => console.log(message),
  ) {
    this.routes = routes;
  }

  get current(): string {
    return this.routes[this.index];
  }

  get all(): readonly string[] {
    return this.routes;
  }

  /** Replaces the list, staying on the current route if it's still in it. */
  setRoutes(routes: string[]): void {
    const current = this.current;
    this.routes = routes;
    this.index = Math.max(0, routes.indexOf(current));
  }

  use(root: string): void {
    const index = this.routes.indexOf(root);
    if (index !== -1 && index !== this.index) {
      this.index = index;
      this.log(`Telegram: now connecting via ${describeRoute(root)}`);
    }
  }

  /**
   * Moves on from `failedRoot` to the next route. False when there's nowhere else to go. If another
   * request already moved on from `failedRoot`, this just reports success without skipping again.
   */
  failover(failedRoot: string): boolean {
    if (this.routes.length < 2) {
      return false;
    }
    if (this.current === failedRoot) {
      this.index = (this.index + 1) % this.routes.length;
      this.log(`Telegram: ${describeRoute(failedRoot)} failed, switching to ${describeRoute(this.current)}`);
    }
    return true;
  }

  /** grammy's `client.buildUrl` — every request goes to whichever route is current right now. */
  readonly buildUrl = (_root: string, token: string, method: string): string => `${this.current}/bot${token}/${method}`;
}

/**
 * Errors that mean "this route didn't work", as opposed to Telegram answering with an error: no
 * connection or a timeout (`HttpError`), a relay answering with something that isn't Bot API JSON
 * (`SyntaxError` from parsing it), or a relay's own server error.
 */
export function isRouteFailure(error: unknown): boolean {
  if (error instanceof HttpError || error instanceof SyntaxError) {
    return true;
  }
  return error instanceof GrammyError && error.error_code >= 500;
}

/**
 * grammy API transformer: on a route failure, check the route with `probe` and switch routes only
 * if that fails too, then retry the call once. One failed request isn't a dead route: switching on
 * every network blip moved bots that can reach Telegram directly onto the shared relays for up to
 * 30 minutes at a time (until `startPreferredRouteCheck` moved them back), and used up the relays'
 * free quotas. Requests failing together share one check.
 */
export function failoverTransformer(
  router: TelegramRouter,
  probe: (root: string) => Promise<RouteProbeResult>,
): Transformer {
  const checks = new Map<string, Promise<boolean>>();
  const routeWorks = (root: string): Promise<boolean> => {
    let check = checks.get(root);
    if (!check) {
      // A rejected token still means the request reached Telegram, so the route itself works.
      check = probe(root)
        .then((result) => result.ok || result.unauthorized === true)
        .finally(() => checks.delete(root));
      checks.set(root, check);
    }
    return check;
  };

  return async (prev, method, payload, signal) => {
    const root = router.current;
    try {
      return await prev(method, payload, signal);
    } catch (error) {
      if (signal?.aborted || !isRouteFailure(error)) {
        throw error;
      }
      if (!(await routeWorks(root)) && !router.failover(root)) {
        throw error;
      }
      return prev(method, payload, signal);
    }
  };
}

export type RouteProbeResult =
  | { ok: true; ms: number; username: string }
  | { ok: false; error: string; unauthorized?: boolean };

/** Calls `getMe` through a route — the check behind startup route selection and `/relays test`. */
export async function probeRoute(
  root: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<RouteProbeResult> {
  const started = Date.now();
  try {
    const response = await fetchImpl(`${root}/bot${token}/getMe`, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401) {
      return { ok: false, error: 'Telegram rejected the bot token', unauthorized: true };
    }
    const body = (await response.json()) as { ok?: boolean; result?: { username?: string }; description?: string };
    if (!body.ok) {
      return { ok: false, error: body.description ?? `HTTP ${response.status}` };
    }
    return { ok: true, ms: Date.now() - started, username: body.result?.username ?? '?' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: /abort|timeout/i.test(message) ? `no answer within ${timeoutMs / 1000}s` : message };
  }
}

/** Switches the router to the first route that works, in order. Returns each route's result. */
export async function selectWorkingRoute(
  router: TelegramRouter,
  probe: (root: string) => Promise<RouteProbeResult>,
): Promise<Map<string, RouteProbeResult>> {
  const results = new Map<string, RouteProbeResult>();
  for (const root of router.all) {
    const result = await probe(root);
    results.set(root, result);
    if (result.ok) {
      router.use(root);
      return results;
    }
  }
  return results;
}

/**
 * While on a fallback route, periodically checks whether an earlier (preferred) route works again
 * — e.g. direct access coming back — and switches to it.
 */
export function startPreferredRouteCheck(
  router: TelegramRouter,
  probe: (root: string) => Promise<RouteProbeResult>,
  intervalMs = 30 * 60_000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    const preferred = router.all.slice(0, router.all.indexOf(router.current));
    void (async () => {
      for (const root of preferred) {
        if ((await probe(root)).ok) {
          router.use(root);
          return;
        }
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return timer;
}
