import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { createAdminStore } from './store.js';
import type { AdminStore } from './types.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://cod2admin:dev_password_change_me@127.0.0.1:5432/cod2admin_dev';
const SECRETS_KEY = randomBytes(32).toString('base64');

describe('DrizzleAdminStore', () => {
  let store: AdminStore;
  let pool: Pool;

  beforeAll(async () => {
    await migrate(DATABASE_URL);
    store = createAdminStore(DATABASE_URL, SECRETS_KEY);
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await store.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE admins, admin_servers, servers, audit_log RESTART IDENTITY CASCADE');
  });

  describe('claimOwner', () => {
    it('claims ownership when no owner exists', async () => {
      await expect(store.claimOwner(111)).resolves.toBe('claimed');
      await expect(store.getAdmin(111)).resolves.toMatchObject({ telegramId: 111, role: 'owner' });
    });

    it('is a no-op (race-safe) once an owner already exists', async () => {
      await store.claimOwner(111);
      await expect(store.claimOwner(222)).resolves.toBe('already-claimed');
      await expect(store.getAdmin(222)).resolves.toBeUndefined();
    });
  });

  describe('admin management', () => {
    it('adds, lists, updates the role of, and removes an admin', async () => {
      await store.claimOwner(1);
      await store.addAdmin(2, 'moderator', 1);

      await expect(store.listAdmins()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ telegramId: 1, role: 'owner' }),
          expect.objectContaining({ telegramId: 2, role: 'moderator', addedBy: 1 }),
        ]),
      );

      await store.setRole(2, 'admin');
      await expect(store.getAdmin(2)).resolves.toMatchObject({ role: 'admin' });

      await store.removeAdmin(2);
      await expect(store.getAdmin(2)).resolves.toBeUndefined();
    });
  });

  describe('servers', () => {
    it('round-trips a server config, decrypting the rcon password transparently', async () => {
      await store.upsertServer({ alias: 'default', rconHost: '127.0.0.1', rconPort: 28960, rconPassword: 'secret-pw' });

      const server = await store.getServer('default');

      expect(server).toMatchObject({ alias: 'default', rconHost: '127.0.0.1', rconPort: 28960, rconPassword: 'secret-pw' });
    });

    it('upserts (updates) an existing server on conflict', async () => {
      await store.upsertServer({ alias: 'default', rconHost: '127.0.0.1', rconPort: 28960, rconPassword: 'old-pw' });
      await store.upsertServer({ alias: 'default', rconHost: '127.0.0.1', rconPort: 28961, rconPassword: 'new-pw' });

      const servers = await store.listServers();

      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({ rconPort: 28961, rconPassword: 'new-pw' });
    });

    it('binds a server to a chat and looks it back up', async () => {
      await store.upsertServer({ alias: 'default', rconHost: '127.0.0.1', rconPort: 28960, rconPassword: 'pw' });

      await store.bindServerToChat('default', 999);

      await expect(store.getServerForChat(999)).resolves.toMatchObject({ alias: 'default' });
    });
  });

  describe('audit log', () => {
    it('records and lists entries, newest first, respecting the limit', async () => {
      await store.recordAuditLog({ actorTelegramId: 1, action: 'kick', target: 'PlayerOne', source: 'telegram_command' });
      await store.recordAuditLog({ actorTelegramId: 1, action: 'ban', target: 'PlayerTwo', source: 'telegram_button' });

      const entries = await store.listAuditLog(1);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ action: 'ban', target: 'PlayerTwo' });
    });
  });
});
