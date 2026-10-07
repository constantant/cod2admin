import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signInitData, validateInitData } from './init-data.js';

const TOKEN = '123456:TEST-token';
const NOW = new Date('2026-10-07T12:00:00.000Z');
const AUTH_DATE = String(NOW.getTime() / 1000 - 60);
const USER = JSON.stringify({
  id: 42,
  first_name: 'Kim',
  username: 'kim_admin',
  language_code: 'en',
});

describe('validateInitData', () => {
  it('accepts initData signed with the bot token and returns the user', () => {
    const raw = signInitData(
      { user: USER, auth_date: AUTH_DATE, query_id: 'AAE' },
      TOKEN,
    );

    expect(validateInitData(raw, TOKEN, { now: NOW })).toEqual({
      ok: true,
      user: { id: 42, username: 'kim_admin', firstName: 'Kim' },
      authDate: new Date(Number(AUTH_DATE) * 1000),
    });
  });

  it('matches the algorithm in Telegram docs, computed independently', () => {
    // data-check-string: every field but hash, sorted, key=value, joined by \n.
    const fields = { auth_date: AUTH_DATE, signature: 'abc', user: USER };
    const dataCheckString = `auth_date=${AUTH_DATE}\nsignature=abc\nuser=${USER}`;
    const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const hash = createHmac('sha256', secret)
      .update(dataCheckString)
      .digest('hex');
    const raw = new URLSearchParams({ ...fields, hash }).toString();

    expect(validateInitData(raw, TOKEN, { now: NOW }).ok).toBe(true);
  });

  it('refuses initData signed with another token', () => {
    const raw = signInitData({ user: USER, auth_date: AUTH_DATE }, '999:other');

    expect(validateInitData(raw, TOKEN, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a tampered field', () => {
    const raw = signInitData(
      { user: USER, auth_date: AUTH_DATE },
      TOKEN,
    ).replace('42', '43');

    expect(validateInitData(raw, TOKEN, { now: NOW })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses missing or malformed hashes', () => {
    expect(validateInitData(undefined, TOKEN)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(validateInitData('', TOKEN)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(validateInitData(`user=${encodeURIComponent(USER)}`, TOKEN)).toEqual(
      { ok: false, reason: 'bad_signature' },
    );
    expect(validateInitData('hash=zz', TOKEN)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses initData older than the max age', () => {
    const raw = signInitData(
      { user: USER, auth_date: String(NOW.getTime() / 1000 - 7200) },
      TOKEN,
    );

    expect(
      validateInitData(raw, TOKEN, { now: NOW, maxAgeSeconds: 3600 }),
    ).toEqual({ ok: false, reason: 'expired' });
    expect(validateInitData(raw, TOKEN, { now: NOW }).ok).toBe(true);
  });

  it('refuses signed initData without a user', () => {
    const raw = signInitData(
      { auth_date: AUTH_DATE, chat_instance: '1' },
      TOKEN,
    );

    expect(validateInitData(raw, TOKEN, { now: NOW })).toEqual({
      ok: false,
      reason: 'no_user',
    });
  });
});
