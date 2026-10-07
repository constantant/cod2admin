import { createHmac, timingSafeEqual } from 'node:crypto';

/** How old an `initData` may be. Telegram signs it once, when the Mini App opens. */
export const DEFAULT_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface InitDataUser {
  id: number;
  username: string | null;
  firstName: string | null;
}

export type InitDataResult =
  | { ok: true; user: InitDataUser; authDate: Date }
  | { ok: false; reason: 'missing' | 'bad_signature' | 'expired' | 'no_user' };

/**
 * Checks the `initData` Telegram hands a Mini App at launch (docs/PLAN-miniapp.md §3/§8): the
 * `hash` field is HMAC-SHA256 over the other fields — sorted, `key=value`, joined by newlines —
 * keyed with HMAC-SHA256("WebAppData", bot token). Only the bot's own token can produce it, so a
 * valid hash proves Telegram vouched for the `user` in it. `auth_date` older than `maxAgeSeconds`
 * is refused, so a leaked string stops working.
 */
export function validateInitData(
  raw: string | undefined,
  botToken: string,
  options: { maxAgeSeconds?: number; now?: Date } = {},
): InitDataResult {
  if (!raw) {
    return { ok: false, reason: 'missing' };
  }
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    return { ok: false, reason: 'bad_signature' };
  }
  params.delete('hash');
  const dataCheckString = [...params]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) {
    return { ok: false, reason: 'bad_signature' };
  }

  const authDate = Number(params.get('auth_date'));
  const nowSeconds = (options.now ?? new Date()).getTime() / 1000;
  if (!Number.isFinite(authDate) || nowSeconds - authDate > (options.maxAgeSeconds ?? DEFAULT_INIT_DATA_MAX_AGE_SECONDS)) {
    return { ok: false, reason: 'expired' };
  }

  const user = parseUser(params.get('user'));
  if (!user) {
    return { ok: false, reason: 'no_user' };
  }
  return { ok: true, user, authDate: new Date(authDate * 1000) };
}

function parseUser(json: string | null): InitDataUser | undefined {
  if (!json) {
    return undefined;
  }
  try {
    const user = JSON.parse(json) as { id?: unknown; username?: unknown; first_name?: unknown };
    if (typeof user.id !== 'number') {
      return undefined;
    }
    return {
      id: user.id,
      username: typeof user.username === 'string' ? user.username : null,
      firstName: typeof user.first_name === 'string' ? user.first_name : null,
    };
  } catch {
    return undefined;
  }
}

/** Builds a validly signed `initData` — for tests and the local dev loop, never sent by Telegram. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}
