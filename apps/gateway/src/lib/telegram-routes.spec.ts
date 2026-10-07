import { readFileSync } from 'node:fs';
import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TELEGRAM_RELAYS,
  DIRECT_TELEGRAM_ROOT,
  failoverTransformer,
  normalizeRelayUrl,
  parseRouteSettings,
  probeRoute,
  routesFrom,
  selectWorkingRoute,
  TelegramRouter,
  type RouteProbeResult,
} from './telegram-routes.js';

const RELAY_A = 'https://a.deno.dev';
const RELAY_B = 'https://b.workers.dev';
const quiet = () => undefined;

function networkError(): HttpError {
  return new HttpError("Network request for 'getUpdates' failed!", new Error('connect ETIMEDOUT'));
}

describe('normalizeRelayUrl', () => {
  it.each([
    ['https://a.deno.dev', 'https://a.deno.dev'],
    ['https://a.deno.dev/', 'https://a.deno.dev'],
    [' https://example.netlify.app/tg/ ', 'https://example.netlify.app/tg'],
  ])('accepts %j', (input, expected) => {
    expect(normalizeRelayUrl(input)).toBe(expected);
  });

  it.each(['http://a.deno.dev', 'a.deno.dev', 'https://a.deno.dev/?x=1', 'https://user:pw@a.deno.dev', 'nonsense'])(
    'rejects %j',
    (input) => {
      expect(normalizeRelayUrl(input)).toBeUndefined();
    },
  );
});

describe('route settings', () => {
  it('puts direct access first, then relays in order', () => {
    expect(routesFrom({ direct: true, relays: [RELAY_A, RELAY_B] })).toEqual([DIRECT_TELEGRAM_ROOT, RELAY_A, RELAY_B]);
    expect(routesFrom({ direct: false, relays: [RELAY_B] })).toEqual([RELAY_B]);
  });

  it('accepts a valid stored setting and rejects malformed or empty ones', () => {
    expect(parseRouteSettings({ direct: false, relays: [`${RELAY_A}/`] })).toEqual({ direct: false, relays: [RELAY_A] });
    expect(parseRouteSettings(undefined)).toBeUndefined();
    expect(parseRouteSettings({ direct: 'yes', relays: [] })).toBeUndefined();
    expect(parseRouteSettings({ direct: true, relays: ['http://plain.example'] })).toBeUndefined();
    expect(parseRouteSettings({ direct: false, relays: [] })).toBeUndefined();
  });
});

describe('TelegramRouter', () => {
  it('builds Bot API URLs on the current route', () => {
    const router = new TelegramRouter([DIRECT_TELEGRAM_ROOT, RELAY_A], quiet);

    expect(router.buildUrl('ignored', '1:abc', 'getMe')).toBe('https://api.telegram.org/bot1:abc/getMe');
    router.use(RELAY_A);
    expect(router.buildUrl('ignored', '1:abc', 'getMe')).toBe('https://a.deno.dev/bot1:abc/getMe');
  });

  it('fails over in order, wrapping around, and only once per failed route', () => {
    const router = new TelegramRouter([DIRECT_TELEGRAM_ROOT, RELAY_A, RELAY_B], quiet);

    expect(router.failover(DIRECT_TELEGRAM_ROOT)).toBe(true);
    expect(router.current).toBe(RELAY_A);
    // A second request that also failed on direct must not skip RELAY_A.
    expect(router.failover(DIRECT_TELEGRAM_ROOT)).toBe(true);
    expect(router.current).toBe(RELAY_A);
    router.failover(RELAY_A);
    router.failover(RELAY_B);
    expect(router.current).toBe(DIRECT_TELEGRAM_ROOT);
  });

  it('has nowhere to fail over to with a single route', () => {
    expect(new TelegramRouter([RELAY_A], quiet).failover(RELAY_A)).toBe(false);
  });

  it('keeps the current route when the list changes, if it\'s still in it', () => {
    const router = new TelegramRouter([DIRECT_TELEGRAM_ROOT, RELAY_A], quiet);
    router.use(RELAY_A);

    router.setRoutes([RELAY_B, RELAY_A]);
    expect(router.current).toBe(RELAY_A);
    router.setRoutes([RELAY_B]);
    expect(router.current).toBe(RELAY_B);
  });
});

describe('failoverTransformer', () => {
  // Plain functions: wrapping a shared vi.fn() in vi.fn() would share its call history across tests.
  const down = async (): Promise<RouteProbeResult> => ({ ok: false, error: 'timeout' });
  const up = async (): Promise<RouteProbeResult> => ({ ok: true, ms: 50, username: 'b' });

  it('fails over to the next route when the check confirms the route is down', async () => {
    const router = new TelegramRouter([DIRECT_TELEGRAM_ROOT, RELAY_A], quiet);
    const usedRoutes: string[] = [];
    const prev = vi.fn(async () => {
      usedRoutes.push(router.current);
      if (router.current === DIRECT_TELEGRAM_ROOT) {
        throw networkError();
      }
      return { ok: true as const, result: true };
    });

    const result = await failoverTransformer(router, down)(prev as never, 'getMe', {} as never);

    expect(result).toEqual({ ok: true, result: true });
    expect(usedRoutes).toEqual([DIRECT_TELEGRAM_ROOT, RELAY_A]);
  });

  it('stays on a route that still works after a one-off failure, and retries there', async () => {
    const router = new TelegramRouter([DIRECT_TELEGRAM_ROOT, RELAY_A], quiet);
    const probe = vi.fn(up);
    const prev = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValueOnce({ ok: true, result: true });

    await expect(failoverTransformer(router, probe)(prev as never, 'getUpdates', {} as never)).resolves.toEqual({ ok: true, result: true });

    expect(probe).toHaveBeenCalledWith(DIRECT_TELEGRAM_ROOT);
    expect(router.current).toBe(DIRECT_TELEGRAM_ROOT);
    expect(prev).toHaveBeenCalledTimes(2);
  });

  it('counts a rejected token as a working route, since the request reached Telegram', async () => {
    const router = new TelegramRouter([DIRECT_TELEGRAM_ROOT, RELAY_A], quiet);
    const probe = vi.fn(async (): Promise<RouteProbeResult> => ({ ok: false, error: 'rejected', unauthorized: true }));
    const prev = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValueOnce({ ok: true, result: true });

    await failoverTransformer(router, probe)(prev as never, 'getMe', {} as never);

    expect(router.current).toBe(DIRECT_TELEGRAM_ROOT);
  });

  it('checks a route once for requests that fail together', async () => {
    const router = new TelegramRouter([DIRECT_TELEGRAM_ROOT, RELAY_A], quiet);
    const probe = vi.fn(up);
    const prev = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue({ ok: true, result: true });
    const transformer = failoverTransformer(router, probe);

    await Promise.all([transformer(prev as never, 'getUpdates', {} as never), transformer(prev as never, 'sendMessage', {} as never)]);

    expect(probe).toHaveBeenCalledOnce();
  });

  it('rethrows when the only route is down', async () => {
    const router = new TelegramRouter([DIRECT_TELEGRAM_ROOT], quiet);
    const failure = networkError();
    const prev = vi.fn().mockRejectedValue(failure);

    await expect(failoverTransformer(router, down)(prev as never, 'getMe', {} as never)).rejects.toBe(failure);
    expect(prev).toHaveBeenCalledOnce();
  });

  it('treats a relay answering with non-JSON or a 5xx as a route failure', async () => {
    for (const error of [new SyntaxError('Unexpected token N'), new GrammyError('x', { ok: false, error_code: 502, description: 'Bad Gateway' }, 'getMe', {})]) {
      const router = new TelegramRouter([RELAY_A, RELAY_B], quiet);
      const prev = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ ok: true, result: true });

      await failoverTransformer(router, down)(prev as never, 'getMe', {} as never);

      expect(router.current).toBe(RELAY_B);
    }
  });

  it('does not fail over when Telegram itself answers with an error', async () => {
    const router = new TelegramRouter([DIRECT_TELEGRAM_ROOT, RELAY_A], quiet);
    const apiError = new GrammyError('x', { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 'sendMessage', {});
    const prev = vi.fn().mockRejectedValue(apiError);
    const probe = vi.fn(down);

    await expect(failoverTransformer(router, probe)(prev as never, 'sendMessage', {} as never)).rejects.toBe(apiError);
    expect(router.current).toBe(DIRECT_TELEGRAM_ROOT);
    expect(prev).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not fail over when the request was cancelled (e.g. the bot is stopping)', async () => {
    const router = new TelegramRouter([DIRECT_TELEGRAM_ROOT, RELAY_A], quiet);
    const controller = new AbortController();
    controller.abort();
    const prev = vi.fn().mockRejectedValue(networkError());

    await expect(failoverTransformer(router, down)(prev as never, 'getUpdates', {} as never, controller.signal as never)).rejects.toBeInstanceOf(HttpError);
    expect(router.current).toBe(DIRECT_TELEGRAM_ROOT);
  });
});

describe('probeRoute', () => {
  function respond(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  }

  it('reports success with the bot username', async () => {
    const fetchImpl = respond(200, { ok: true, result: { username: 'my_bot' } });

    await expect(probeRoute(RELAY_A, '1:abc', fetchImpl)).resolves.toMatchObject({ ok: true, username: 'my_bot' });
    expect(fetchImpl).toHaveBeenCalledWith('https://a.deno.dev/bot1:abc/getMe', expect.anything());
  });

  it('tells a rejected token apart from an unreachable route', async () => {
    await expect(probeRoute(RELAY_A, '1:abc', respond(401, { ok: false }))).resolves.toMatchObject({ ok: false, unauthorized: true });

    const unreachable = vi.fn(async () => {
      throw new Error('connect ETIMEDOUT');
    }) as unknown as typeof fetch;
    await expect(probeRoute(RELAY_A, '1:abc', unreachable)).resolves.toEqual({ ok: false, error: 'connect ETIMEDOUT' });
  });
});

describe('selectWorkingRoute', () => {
  it('switches to the first route that works', async () => {
    const router = new TelegramRouter([DIRECT_TELEGRAM_ROOT, RELAY_A, RELAY_B], quiet);
    const probe = vi.fn(async (root: string): Promise<RouteProbeResult> =>
      root === DIRECT_TELEGRAM_ROOT ? { ok: false, error: 'timeout' } : { ok: true, ms: 80, username: 'b' },
    );

    await selectWorkingRoute(router, probe);

    expect(router.current).toBe(RELAY_A);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('DEFAULT_TELEGRAM_RELAYS', () => {
  it('matches the list in installer/install.sh, which checks routes before the bot is installed', () => {
    const installSh = readFileSync(new URL('../../../../installer/install.sh', import.meta.url), 'utf8');
    const match = /^DEFAULT_TELEGRAM_RELAYS="([^"]*)"/m.exec(installSh);

    expect(match).not.toBeNull();
    expect(match![1].split(',').filter(Boolean)).toEqual([...DEFAULT_TELEGRAM_RELAYS]);
  });
});
