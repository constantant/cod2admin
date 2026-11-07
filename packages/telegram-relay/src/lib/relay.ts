/**
 * A Telegram Bot API relay for bots whose host can't reach api.telegram.org — servers in Russia
 * (docs/PLAN-russia-access.md). Deployed for free on edge platforms (Deno Deploy, Cloudflare
 * Workers, Netlify), which Russian hosting networks can still reach: the bot sends its usual Bot
 * API requests here, and this forwards them to Telegram unchanged.
 *
 * Uses only web-standard Request/Response/fetch, so the same code runs on every platform; see
 * `deploy/` for the two-line entry files.
 *
 * - Only Bot API paths are forwarded (`/bot<token>/<method>`, `/file/bot<token>/<path>`), so this
 *   can't be used as an open proxy to anything else.
 * - `GET /client-metadata?url=` fetches one public OAuth client-metadata document from a host
 *   that refuses the bot's own address (Claude redirects Russian visitors; ChatGPT answers 403).
 *   The host and `/oauth/` path are fixed. Redirects are not followed.
 * - Nothing is logged or stored. Bot tokens are part of every request path, so the person running a
 *   relay could see them — use a relay you or someone you trust runs.
 * - `GET /health` checks the relay can reach Telegram, without needing a bot token. It's what
 *   `/relays test` and the deployment checks call.
 */

const TELEGRAM_API = 'https://api.telegram.org';
const METADATA_BYTES = 8 * 1024;

/**
 * Hosts whose client-metadata documents answer 200 from the relay's network and 302/403 from
 * Russian hosting. Anything else stays 404, so this route is not a general-purpose proxy.
 */
const METADATA_HOSTS = new Set(['claude.ai', 'chatgpt.com']);

const BOT_API_PATH = /^\/(?:file\/)?bot\d+:[A-Za-z0-9_-]+\/[^?#]*$/;

/** Request headers worth forwarding. Everything else (cookies, client IPs, ...) is dropped. */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept'];

/** Response headers worth passing back. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-disposition'];

function pickHeaders(source: Headers, names: string[]): Headers {
  const picked = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) {
      picked.set(name, value);
    }
  }
  return picked;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handleRelayRequest(request: Request, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    try {
      // api.telegram.org answers its root with a redirect to the docs — any HTTP answer at all
      // proves the relay → Telegram leg works.
      const response = await fetchImpl(`${TELEGRAM_API}/`, { redirect: 'manual' });
      return json({ ok: true, telegramStatus: response.status });
    } catch (error) {
      return json({ ok: false, error: String(error) }, 502);
    }
  }

  if (url.pathname === '/client-metadata') {
    if (request.method !== 'GET') {
      return new Response('Not found', { status: 404 });
    }
    return fetchClientMetadata(url.searchParams.get('url'), fetchImpl);
  }

  if (!BOT_API_PATH.test(url.pathname) || (request.method !== 'GET' && request.method !== 'POST')) {
    return new Response('Not found', { status: 404 });
  }

  const upstream = await fetchImpl(`${TELEGRAM_API}${url.pathname}${url.search}`, {
    method: request.method,
    headers: pickHeaders(request.headers, FORWARDED_REQUEST_HEADERS),
    // Bot API payloads are small JSON bodies; buffering keeps this portable across runtimes.
    body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: pickHeaders(upstream.headers, FORWARDED_RESPONSE_HEADERS),
  });
}

/**
 * The exact https URL the relay will fetch. Undefined unless it is `claude.ai` or `chatgpt.com`,
 * under `/oauth/`, with no query, fragment, port, or credentials. The URL parser resolves `..`.
 */
export function clientMetadataTarget(raw: string | null): string | undefined {
  if (!raw || raw.length > 300) {
    return undefined;
  }
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.port ||
    !METADATA_HOSTS.has(target.hostname) ||
    !target.pathname.startsWith('/oauth/')
  ) {
    return undefined;
  }
  return target.toString();
}

async function fetchClientMetadata(
  raw: string | null,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const target = clientMetadataTarget(raw);
  if (!target) {
    return new Response('Not found', { status: 404 });
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
  } catch {
    return json({ ok: false, error: 'fetch failed' }, 502);
  }
  if (upstream.status !== 200) {
    await upstream.body?.cancel();
    return json({ ok: false, status: upstream.status }, 502);
  }
  const body = await upstream.arrayBuffer();
  if (body.byteLength > METADATA_BYTES) {
    return json({ ok: false, error: 'too large' }, 502);
  }
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
