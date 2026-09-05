import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { createBanStore } from './store.js';
import type { BanStore } from './types.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://cod2admin:dev_password_change_me@127.0.0.1:5432/cod2admin_dev';

describe('DrizzleBanStore', () => {
  let store: BanStore;
  let pool: Pool;

  beforeAll(async () => {
    await migrate(DATABASE_URL);
    store = createBanStore(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await store.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE bans, ban_ips RESTART IDENTITY CASCADE');
  });

  it('records a permanent (GUID-path) ban with no expiry and an unknown guid', async () => {
    await store.recordBan({ serverAlias: 'default', name: 'PlayerOne', reason: 'cheating', bannedBy: 1 });

    const { rows } = await pool.query('SELECT * FROM bans');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ server_alias: 'default', guid: null, name: 'PlayerOne', reason: 'cheating', expires_at: null });
  });

  it('records an IP ban with an expiry and lists it as active', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    await store.recordIpBan({ serverAlias: 'default', ip: '1.2.3.4', reason: 'griefing', bannedBy: 1, expiresAt });

    const active = await store.listActiveIpBans('default');

    expect(active).toEqual([expect.objectContaining({ ip: '1.2.3.4', reason: 'griefing' })]);
  });

  it('lists a permanent IP ban (no expiry) as active', async () => {
    await store.recordIpBan({ serverAlias: 'default', ip: '1.2.3.4', bannedBy: 1, expiresAt: null });

    const active = await store.listActiveIpBans('default');

    expect(active).toHaveLength(1);
  });

  it('lists an IP ban whose expiry has passed as expired, and expireIpBan removes it', async () => {
    const expiresAt = new Date(Date.now() - 1000);
    await store.recordIpBan({ serverAlias: 'default', ip: '1.2.3.4', bannedBy: 1, expiresAt });

    const expired = await store.listExpiredIpBans('default', new Date());
    expect(expired).toHaveLength(1);

    await store.expireIpBan(expired[0].id);

    await expect(store.listActiveIpBans('default')).resolves.toEqual([]);
  });

  it('scopes active/expired lookups to the given server alias', async () => {
    await store.recordIpBan({ serverAlias: 'other', ip: '9.9.9.9', bannedBy: 1, expiresAt: new Date(Date.now() + 60_000) });

    await expect(store.listActiveIpBans('default')).resolves.toEqual([]);
  });
});
