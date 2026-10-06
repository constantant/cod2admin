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

  it('records a GUID-path ban with a real guid and an expiry (the report card Temp Ban button, §5 step 6)', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    await store.recordBan({ serverAlias: 'default', name: 'PlayerOne', guid: 'realguid', reason: 'aimbot', bannedBy: 1, expiresAt });

    const { rows } = await pool.query('SELECT * FROM bans');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guid: 'realguid', expires_at: expiresAt });
  });

  it('records an IP ban with an expiry and lists it as active', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    await store.recordIpBan({ serverAlias: 'default', ip: '1.2.3.4', reason: 'griefing', bannedBy: 1, expiresAt });

    const active = await store.listActiveIpBans();

    expect(active).toEqual([expect.objectContaining({ ip: '1.2.3.4', reason: 'griefing' })]);
  });

  it('lists a permanent IP ban (no expiry) as active', async () => {
    await store.recordIpBan({ serverAlias: 'default', ip: '1.2.3.4', bannedBy: 1, expiresAt: null });

    const active = await store.listActiveIpBans();

    expect(active).toHaveLength(1);
  });

  it('lists an IP ban whose expiry has passed as expired, and expireIpBan removes it', async () => {
    const expiresAt = new Date(Date.now() - 1000);
    await store.recordIpBan({ serverAlias: 'default', ip: '1.2.3.4', bannedBy: 1, expiresAt });

    const expired = await store.listExpiredIpBans(new Date());
    expect(expired).toHaveLength(1);

    await store.expireIpBan(expired[0].id);

    await expect(store.listActiveIpBans()).resolves.toEqual([]);
  });

  it('lists bans from every server, keeping the server each was issued on', async () => {
    await store.recordIpBan({ serverAlias: 'default', ip: '1.1.1.1', bannedBy: 1, expiresAt: null });
    await store.recordIpBan({ serverAlias: 'other', ip: '9.9.9.9', bannedBy: 1, expiresAt: null });

    const active = await store.listActiveIpBans();

    expect(active.map((ban) => [ban.serverAlias, ban.ip]).sort()).toEqual([
      ['default', '1.1.1.1'],
      ['other', '9.9.9.9'],
    ]);
  });

  describe('GUID-path ban expiry (docs/PLAN.md §5 step 7 job (b))', () => {
    it('lists a GUID-path temp ban whose expiry has passed, and expireBan removes it', async () => {
      const expiresAt = new Date(Date.now() - 1000);
      await store.recordBan({ serverAlias: 'default', name: 'PlayerOne', guid: 'realguid', bannedBy: 1, expiresAt });

      const expired = await store.listExpiredBans(new Date());
      expect(expired).toEqual([expect.objectContaining({ guid: 'realguid', serverAlias: 'default' })]);

      await store.expireBan(expired[0].id);

      await expect(store.listExpiredBans(new Date())).resolves.toEqual([]);
    });

    it('does not list a permanent ban (no expiry) or one whose expiry is still in the future', async () => {
      await store.recordBan({ serverAlias: 'default', name: 'Permanent', guid: 'guid-a', bannedBy: 1 });
      await store.recordBan({ serverAlias: 'default', name: 'NotYet', guid: 'guid-b', bannedBy: 1, expiresAt: new Date(Date.now() + 60_000) });

      await expect(store.listExpiredBans(new Date())).resolves.toEqual([]);
    });
  });

  describe('listActiveBans (docs/PLAN.md §6, /bans)', () => {
    it('lists permanent and not-yet-expired GUID bans from every server as active', async () => {
      await store.recordBan({ serverAlias: 'default', name: 'Permanent', guid: 'guid-a', bannedBy: 1 });
      await store.recordBan({ serverAlias: 'default', name: 'NotYet', guid: 'guid-b', bannedBy: 1, expiresAt: new Date(Date.now() + 60_000) });
      await store.recordBan({ serverAlias: 'other', name: 'Elsewhere', guid: 'guid-c', bannedBy: 1 });

      const active = await store.listActiveBans();

      expect(active.map((b) => b.name).sort()).toEqual(['Elsewhere', 'NotYet', 'Permanent']);
    });

    it('excludes a GUID ban whose expiry has already passed', async () => {
      await store.recordBan({ serverAlias: 'default', name: 'Expired', guid: 'guid-a', bannedBy: 1, expiresAt: new Date(Date.now() - 1000) });

      await expect(store.listActiveBans()).resolves.toEqual([]);
    });
  });

  describe('unban (docs/PLAN.md §6, /unban <guid-or-ip>)', () => {
    it('unbanByGuid stamps unbannedAt on the matching active bans row, removing it from listActiveBans', async () => {
      await store.recordBan({ serverAlias: 'default', name: 'Cheater', guid: 'guid-a', bannedBy: 1 });

      await expect(store.unbanByGuid('guid-a')).resolves.toEqual([
        expect.objectContaining({ name: 'Cheater', serverAlias: 'default', guid: 'guid-a' }),
      ]);

      await expect(store.listActiveBans()).resolves.toEqual([]);
      const [row] = await store.listBansByGuid('guid-a', 10);
      expect(row.unbannedAt).not.toBeNull();
    });

    it('unbanByGuid lifts that guid on every server and leaves other guids alone', async () => {
      await store.recordBan({ serverAlias: 'default', name: 'Here', guid: 'guid-a', bannedBy: 1 });
      await store.recordBan({ serverAlias: 'other', name: 'Elsewhere', guid: 'guid-a', bannedBy: 1 });
      await store.recordBan({ serverAlias: 'default', name: 'Other', guid: 'guid-b', bannedBy: 1 });

      await expect(store.unbanByGuid('guid-a')).resolves.toHaveLength(2);

      await expect(store.listActiveBans()).resolves.toEqual([expect.objectContaining({ guid: 'guid-b' })]);
      await expect(store.unbanByGuid('guid-a')).resolves.toEqual([]);
    });

    it('unbanIp stamps unbannedAt on the matching active ban_ips row, removing it from listActiveIpBans', async () => {
      await store.recordIpBan({ serverAlias: 'default', ip: '1.2.3.4', bannedBy: 1, expiresAt: null });

      await expect(store.unbanIp('1.2.3.4')).resolves.toBe(1);

      await expect(store.listActiveIpBans()).resolves.toEqual([]);
      const [row] = await store.listIpBansByIp('1.2.3.4', 10);
      expect(row.unbannedAt).not.toBeNull();
    });
  });

  describe('history lookups (docs/PLAN.md §5 step 3)', () => {
    it('finds bans by GUID on every server, newest first, up to the limit', async () => {
      // Explicit banned_at values so "newest first" isn't left to same-statement now() ties.
      await pool.query(
        "INSERT INTO bans (server_alias, guid, name, banned_by, banned_at) VALUES " +
          "('default', 'abc123', 'Old Name', 1, now() - interval '2 hours')," +
          "('default', 'abc123', 'New Name', 1, now())," +
          "('other', 'abc123', 'Elsewhere', 1, now() - interval '1 hour')",
      );

      await expect(store.listBansByGuid('abc123', 10)).resolves.toEqual([
        expect.objectContaining({ name: 'New Name' }),
        expect.objectContaining({ name: 'Elsewhere', serverAlias: 'other' }),
        expect.objectContaining({ name: 'Old Name' }),
      ]);
      await expect(store.listBansByGuid('abc123', 1)).resolves.toHaveLength(1);
    });

    it('finds bans by name case-insensitively — the only lookup that matches real recordBan data today', async () => {
      await store.recordBan({ serverAlias: 'default', name: 'Cheatr123', reason: 'aimbot', bannedBy: 1 });

      const found = await store.listBansByName('CHEATR123', 10);

      expect(found).toEqual([expect.objectContaining({ name: 'Cheatr123', reason: 'aimbot' })]);
    });

    it('finds IP bans by exact IP on every server, newest first', async () => {
      await pool.query(
        'INSERT INTO ban_ips (server_alias, ip, reason, banned_by, banned_at) VALUES ' +
          "('default', '1.2.3.4', 'first', 1, now() - interval '2 hours')," +
          "('other', '1.2.3.4', 'second', 1, now() - interval '1 hour')," +
          "('default', '9.9.9.9', 'unrelated', 1, now())",
      );

      const found = await store.listIpBansByIp('1.2.3.4', 10);

      expect(found).toEqual([
        expect.objectContaining({ reason: 'second', serverAlias: 'other' }),
        expect.objectContaining({ reason: 'first' }),
      ]);
    });
  });
});
