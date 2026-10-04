import { describe, expect, it, vi } from 'vitest';
import { handleRelayRequest } from './relay.js';

const TOKEN = '123456789:TEST-fake-token_not-real-0123456789';

function fakeFetch(response: Response = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response);
}

describe('handleRelayRequest', () => {
  it('forwards a Bot API POST to api.telegram.org with its body, query and content type', async () => {
    const fetchImpl = fakeFetch();
    const request = new Request(`https://relay.example/bot${TOKEN}/sendMessage?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'secret=1', 'x-forwarded-for': '1.2.3.4' },
      body: '{"chat_id":1,"text":"hi"}',
    });

    const response = await handleRelayRequest(request, fetchImpl);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage?x=1`);
    expect(init?.method).toBe('POST');
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe('{"chat_id":1,"text":"hi"}');
    const headers = init?.headers as Headers;
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-forwarded-for')).toBeNull();
  });

  it('forwards file downloads and passes Telegram\'s status through', async () => {
    const fetchImpl = fakeFetch(new Response('nope', { status: 401 }));

    const response = await handleRelayRequest(new Request(`https://relay.example/file/bot${TOKEN}/photos/a.jpg`), fetchImpl);

    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/a.jpg`);
    expect(response.status).toBe(401);
  });

  it.each([
    '/',
    '/anything',
    '/bot/getMe',
    '/botnotatoken/getMe',
    `/x/bot${TOKEN}/getMe`,
    '/https://evil.example/',
  ])('refuses %s so it can\'t be used as an open proxy', async (path) => {
    const fetchImpl = fakeFetch();

    const response = await handleRelayRequest(new Request(`https://relay.example${path}`), fetchImpl);

    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses methods other than GET and POST', async () => {
    const fetchImpl = fakeFetch();

    const response = await handleRelayRequest(new Request(`https://relay.example/bot${TOKEN}/getMe`, { method: 'DELETE' }), fetchImpl);

    expect(response.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports health by reaching Telegram, without a bot token', async () => {
    const fetchImpl = fakeFetch(new Response(null, { status: 302 }));

    const response = await handleRelayRequest(new Request('https://relay.example/health'), fetchImpl);

    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.telegram.org/');
    expect(await response.json()).toEqual({ ok: true, telegramStatus: 302 });
  });

  it('reports unhealthy when Telegram can\'t be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect timeout');
    });

    const response = await handleRelayRequest(new Request('https://relay.example/health'), fetchImpl);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});
