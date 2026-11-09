import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { PermissionError } from './permissions.js';
import { createAdminStore } from './store.js';
import type { AdminStore } from './types.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://cod2admin:dev_password_change_me@127.0.0.1:5432/cod2admin_dev';
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
    await pool.query(
      'TRUNCATE admin_permissions, admins, admin_servers, servers, audit_log, settings, telegram_users, reports, player_notes, known_players, server_snapshots RESTART IDENTITY CASCADE',
    );
  });

  describe('claimOwner', () => {
    it('claims ownership when no owner exists', async () => {
      await expect(store.claimOwner(111)).resolves.toBe('claimed');
      await expect(store.getAdmin(111)).resolves.toMatchObject({
        telegramId: 111,
        isOwner: true,
        permissions: [],
      });
    });

    it('is a no-op (race-safe) once an owner already exists', async () => {
      await store.claimOwner(111);
      await expect(store.claimOwner(222)).resolves.toBe('already-claimed');
      await expect(store.getAdmin(222)).resolves.toBeUndefined();
    });
  });

  describe('admin management', () => {
    it('adds, lists, replaces permissions, and removes an admin', async () => {
      await store.claimOwner(1);
      await store.addAdmin(2, ['kick', 'tempban', 'mute'], 1);

      await expect(store.listAdmins()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            telegramId: 1,
            isOwner: true,
            permissions: [],
          }),
          expect.objectContaining({
            telegramId: 2,
            isOwner: false,
            permissions: ['kick', 'tempban', 'mute'],
            addedBy: 1,
          }),
        ]),
      );

      await store.setPermissions(2, ['kick', 'ban']);
      await expect(store.getAdmin(2)).resolves.toMatchObject({
        isOwner: false,
        permissions: ['kick', 'ban'],
      });

      await expect(
        store.setPermissions(2, ['not-a-permission' as 'kick']),
      ).rejects.toBeInstanceOf(PermissionError);

      await store.removeAdmin(2);
      await expect(store.getAdmin(2)).resolves.toBeUndefined();
      await expect(
        pool.query('SELECT * FROM admin_permissions WHERE telegram_id = 2'),
      ).resolves.toMatchObject({ rowCount: 0 });
    });
  });

  describe('servers', () => {
    it('round-trips a server config, decrypting the rcon password transparently', async () => {
      await store.upsertServer({
        alias: 'default',
        rconHost: '127.0.0.1',
        rconPort: 28960,
        rconPassword: 'secret-pw',
      });

      const server = await store.getServer('default');

      expect(server).toMatchObject({
        alias: 'default',
        rconHost: '127.0.0.1',
        rconPort: 28960,
        rconPassword: 'secret-pw',
      });
    });

    it('upserts (updates) an existing server on conflict', async () => {
      await store.upsertServer({
        alias: 'default',
        rconHost: '127.0.0.1',
        rconPort: 28960,
        rconPassword: 'old-pw',
      });
      await store.upsertServer({
        alias: 'default',
        rconHost: '127.0.0.1',
        rconPort: 28961,
        rconPassword: 'new-pw',
      });

      const servers = await store.listServers();

      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        rconPort: 28961,
        rconPassword: 'new-pw',
      });
    });

    it('upserts logSourceConfig on conflict too (real bug: re-running install.sh with a newly-added COD2_LOG_PATH silently never persisted it)', async () => {
      await store.upsertServer({
        alias: 'default',
        rconHost: '127.0.0.1',
        rconPort: 28960,
        rconPassword: 'pw',
      });
      await store.upsertServer({
        alias: 'default',
        rconHost: '127.0.0.1',
        rconPort: 28960,
        rconPassword: 'pw',
        logSourceConfig: '/path/to/games_mp.log',
      });

      await expect(store.getServer('default')).resolves.toMatchObject({
        logSourceConfig: '/path/to/games_mp.log',
      });
    });

    it('keeps a log path set by setServerLogPath when the server is upserted without one', async () => {
      await store.upsertServer({
        alias: 'default',
        rconHost: 'h',
        rconPort: 1,
        rconPassword: 'pw',
      });
      await store.setServerLogPath('default', '/found/games_mp.log');

      await store.upsertServer({
        alias: 'default',
        rconHost: 'h',
        rconPort: 1,
        rconPassword: 'new-pw',
      });
      await expect(store.getServer('default')).resolves.toMatchObject({
        logSourceConfig: '/found/games_mp.log',
      });

      await store.setServerLogPath('default', null);
      await expect(store.getServer('default')).resolves.toMatchObject({
        logSourceConfig: null,
      });
    });

    it('binds a server to a chat and looks it back up', async () => {
      await store.upsertServer({
        alias: 'default',
        rconHost: '127.0.0.1',
        rconPort: 28960,
        rconPassword: 'pw',
      });

      await store.bindServerToChat('default', 999);

      await expect(store.getServerForChat(999)).resolves.toMatchObject({
        alias: 'default',
      });
    });

    it('keeps exactly one default server, switching it on setDefaultServer', async () => {
      await store.upsertServer({
        alias: 'a',
        rconHost: 'h',
        rconPort: 1,
        rconPassword: 'pw',
      });
      await store.upsertServer({
        alias: 'b',
        rconHost: 'h',
        rconPort: 2,
        rconPassword: 'pw',
      });
      await expect(store.getDefaultServer()).resolves.toBeUndefined();

      await expect(store.setDefaultServer('a')).resolves.toBe(true);
      await expect(store.getDefaultServer()).resolves.toMatchObject({
        alias: 'a',
        isDefault: true,
      });

      await expect(store.setDefaultServer('b')).resolves.toBe(true);
      await expect(store.getDefaultServer()).resolves.toMatchObject({
        alias: 'b',
      });
      await expect(store.getServer('a')).resolves.toMatchObject({
        isDefault: false,
      });
    });

    it('leaves the default unchanged when asked to default an unknown server', async () => {
      await store.upsertServer({
        alias: 'a',
        rconHost: 'h',
        rconPort: 1,
        rconPassword: 'pw',
      });
      await store.setDefaultServer('a');

      await expect(store.setDefaultServer('nope')).resolves.toBe(false);
      await expect(store.getDefaultServer()).resolves.toMatchObject({
        alias: 'a',
      });
    });

    it('keeps the default flag when the same server is upserted again (e.g. on every boot)', async () => {
      await store.upsertServer({
        alias: 'a',
        rconHost: 'h',
        rconPort: 1,
        rconPassword: 'pw',
      });
      await store.setDefaultServer('a');
      await store.upsertServer({
        alias: 'a',
        rconHost: 'h',
        rconPort: 1,
        rconPassword: 'new-pw',
      });

      await expect(store.getDefaultServer()).resolves.toMatchObject({
        alias: 'a',
      });
    });

    it('removes a server and its per-admin scoping rows', async () => {
      await store.upsertServer({
        alias: 'a',
        rconHost: 'h',
        rconPort: 1,
        rconPassword: 'pw',
      });
      await pool.query(
        "INSERT INTO admin_servers (telegram_id, server_alias) VALUES (1, 'a')",
      );

      await expect(store.removeServer('a')).resolves.toBe(true);
      await expect(store.getServer('a')).resolves.toBeUndefined();
      await expect(
        pool.query('SELECT * FROM admin_servers'),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(store.removeServer('a')).resolves.toBe(false);
    });
  });

  describe('telegram users', () => {
    it("joins an admin's saved name onto getAdmin/listAdmins, null until saved", async () => {
      await store.claimOwner(1);
      await expect(store.getAdmin(1)).resolves.toMatchObject({
        username: null,
        firstName: null,
      });

      await store.saveTelegramUser({
        telegramId: 1,
        username: 'old_nick',
        firstName: 'Kostya',
      });
      await store.saveTelegramUser({
        telegramId: 1,
        username: 'new_nick',
        firstName: 'Kostya',
      });

      await expect(store.getAdmin(1)).resolves.toMatchObject({
        telegramId: 1,
        isOwner: true,
        username: 'new_nick',
        firstName: 'Kostya',
      });
      await expect(store.listAdmins()).resolves.toEqual([
        expect.objectContaining({ telegramId: 1, username: 'new_nick' }),
      ]);
    });

    it('names the actor of audit log entries, even after the admin was removed', async () => {
      await store.addAdmin(2, ['kick'], 1);
      await store.saveTelegramUser({
        telegramId: 2,
        username: null,
        firstName: 'Vasya',
      });
      await store.recordAuditLog({
        actorTelegramId: 2,
        action: 'kick',
        target: 'Cheatr123',
        serverAlias: 'default',
        source: 'telegram_command',
      });
      await store.recordAuditLog({
        actorTelegramId: 3,
        action: 'kick',
        target: 'Cheatr123',
        serverAlias: 'default',
        source: 'telegram_command',
      });
      await store.removeAdmin(2);

      await expect(store.listAuditLog(10)).resolves.toEqual([
        expect.objectContaining({
          actorTelegramId: 3,
          actorUsername: null,
          actorFirstName: null,
        }),
        expect.objectContaining({
          actorTelegramId: 2,
          actorUsername: null,
          actorFirstName: 'Vasya',
        }),
      ]);
      await expect(
        store.listAuditLogForTarget('default', 'Cheatr123', 10),
      ).resolves.toEqual([
        expect.objectContaining({ actorTelegramId: 3, actorFirstName: null }),
        expect.objectContaining({
          actorTelegramId: 2,
          actorFirstName: 'Vasya',
        }),
      ]);
    });
  });

  describe('settings', () => {
    it('stores, overwrites and deletes a JSON setting', async () => {
      await expect(
        store.getSetting('telegram.routes'),
      ).resolves.toBeUndefined();

      await store.setSetting('telegram.routes', {
        direct: true,
        relays: ['https://a.example'],
      });
      await store.setSetting('telegram.routes', {
        direct: false,
        relays: ['https://b.example'],
      });
      await expect(store.getSetting('telegram.routes')).resolves.toEqual({
        direct: false,
        relays: ['https://b.example'],
      });

      await store.deleteSetting('telegram.routes');
      await expect(
        store.getSetting('telegram.routes'),
      ).resolves.toBeUndefined();
    });
  });

  describe('audit log', () => {
    it('records and lists entries, newest first, respecting the limit', async () => {
      await store.recordAuditLog({
        actorTelegramId: 1,
        action: 'kick',
        target: 'PlayerOne',
        source: 'telegram_command',
      });
      await store.recordAuditLog({
        actorTelegramId: 1,
        action: 'ban',
        target: 'PlayerTwo',
        source: 'telegram_button',
      });

      const entries = await store.listAuditLog(1);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ action: 'ban', target: 'PlayerTwo' });
    });

    it('finds prior entries for a target, case-insensitively, scoped to the server and newest first', async () => {
      await store.recordAuditLog({
        actorTelegramId: 1,
        action: 'kick',
        target: 'Cheatr123',
        serverAlias: 'default',
        source: 'telegram_command',
      });
      await store.recordAuditLog({
        actorTelegramId: 1,
        action: 'ban',
        target: 'cheatr123',
        serverAlias: 'default',
        source: 'telegram_button',
      });
      await store.recordAuditLog({
        actorTelegramId: 1,
        action: 'kick',
        target: 'Cheatr123',
        serverAlias: 'other',
        source: 'telegram_command',
      });
      await store.recordAuditLog({
        actorTelegramId: 1,
        action: 'kick',
        target: 'SomeoneElse',
        serverAlias: 'default',
        source: 'telegram_command',
      });

      const entries = await store.listAuditLogForTarget(
        'default',
        'CHEATR123',
        10,
      );

      expect(entries.map((e) => e.action)).toEqual(['ban', 'kick']);
    });

    it('respects the limit on a targeted lookup too', async () => {
      await store.recordAuditLog({
        actorTelegramId: 1,
        action: 'kick',
        target: 'Cheatr123',
        serverAlias: 'default',
        source: 'telegram_command',
      });
      await store.recordAuditLog({
        actorTelegramId: 1,
        action: 'ban',
        target: 'Cheatr123',
        serverAlias: 'default',
        source: 'telegram_button',
      });

      const entries = await store.listAuditLogForTarget(
        'default',
        'Cheatr123',
        1,
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ action: 'ban' });
    });
  });

  describe('searchAuditLog', () => {
    const entry = (action: string, target: string, serverAlias = 'a') =>
      store.recordAuditLog({
        actorTelegramId: 1,
        action,
        target,
        serverAlias,
        source: 'miniapp',
      });

    it('filters by action, server and text, and treats % as plain text', async () => {
      await entry('kick', 'Alice');
      await entry('ban', 'Bob 100%');
      await entry('ban', 'Carol', 'b');

      const byAction = await store.searchAuditLog({ action: 'ban', limit: 10 });
      expect(byAction.map((row) => row.target)).toEqual(['Carol', 'Bob 100%']);
      const byServer = await store.searchAuditLog({
        serverAlias: 'b',
        limit: 10,
      });
      expect(byServer.map((row) => row.target)).toEqual(['Carol']);
      const byText = await store.searchAuditLog({ query: '%', limit: 10 });
      expect(byText.map((row) => row.target)).toEqual(['Bob 100%']);
      expect(await store.listAuditActions()).toEqual(['ban', 'kick']);
    });

    it('pages with limit and offset', async () => {
      await entry('kick', 'one');
      await entry('kick', 'two');

      const page = await store.searchAuditLog({ limit: 1, offset: 1 });

      expect(page.map((row) => row.target)).toEqual(['one']);
    });
  });

  describe('reports', () => {
    const input = {
      serverAlias: 'a',
      reporterName: 'Honest',
      targetName: 'Cheater',
      reason: 'aim',
    };

    it('counts a repeat on the open report instead of adding a row', async () => {
      const first = await store.recordReport(input);
      const second = await store.recordReport({
        ...input,
        targetName: 'CHEATER',
        reason: 'wallhack',
      });

      expect(second.id).toBe(first.id);
      expect(second.count).toBe(2);
      expect(second.reason).toBe('wallhack');
      expect(await store.countOpenReports()).toBe(1);
    });

    it('starts a new report once the last one is closed, and closes a report only once', async () => {
      const first = await store.recordReport(input);
      const closed = await store.resolveReport(first.id, {
        status: 'ignored',
        resolvedBy: 9,
        outcome: 'Ignored',
      });
      expect(closed).toMatchObject({
        status: 'ignored',
        resolvedBy: 9,
        outcome: 'Ignored',
      });

      expect(
        await store.resolveReport(first.id, {
          status: 'handled',
          resolvedBy: 8,
        }),
      ).toBeUndefined();
      const again = await store.recordReport(input);
      expect(again.id).not.toBe(first.id);
      expect(
        (await store.searchReports({ resolved: false, limit: 10 })).map(
          (row) => row.id,
        ),
      ).toEqual([again.id]);
      expect(
        (await store.searchReports({ resolved: true, limit: 10 })).map(
          (row) => row.id,
        ),
      ).toEqual([first.id]);
    });
  });

  describe('known players', () => {
    it('saves, replaces, lists and deletes by name', async () => {
      const saved = await store.saveKnownPlayer({
        name: 'vasya',
        display: '^1Vasya',
        asns: [12389, 4_200_000_000],
        createdBy: 1,
      });
      expect(saved).toMatchObject({ name: 'vasya', asns: [12389, 4_200_000_000], note: null });
      await store.saveKnownPlayer({ name: 'anna', display: 'Anna', asns: [8359], createdBy: 1 });

      const replaced = await store.saveKnownPlayer({
        name: 'vasya',
        display: 'Vasya',
        asns: [12389],
        note: 'home',
        createdBy: 2,
      });
      expect(replaced).toMatchObject({ display: 'Vasya', asns: [12389], note: 'home', createdBy: 1 });

      expect((await store.listKnownPlayers()).map((p) => p.name)).toEqual(['anna', 'vasya']);
      await expect(store.deleteKnownPlayer('vasya')).resolves.toBe(true);
      await expect(store.deleteKnownPlayer('vasya')).resolves.toBe(false);
    });
  });

  describe('player notes', () => {
    it('finds notes by exact identity and by search, and edits and deletes them', async () => {
      const note = await store.addPlayerNote({
        kind: 'ip',
        value: '203.0.113.7',
        note: 'smurf',
        watch: true,
        createdBy: 1,
      });
      await store.addPlayerNote({
        kind: 'name',
        value: 'bob',
        note: 'rude',
        watch: false,
        createdBy: 1,
      });

      const found = await store.findPlayerNotes([
        { kind: 'ip', value: '203.0.113.7' },
        { kind: 'guid', value: '203.0.113.7' },
      ]);
      expect(found.map((row) => row.id)).toEqual([note.id]);
      expect(await store.findPlayerNotes([])).toEqual([]);
      expect(
        (await store.searchPlayerNotes({ query: 'RUDE', limit: 10 })).map(
          (row) => row.value,
        ),
      ).toEqual(['bob']);
      expect(
        (await store.searchPlayerNotes({ watchOnly: true, limit: 10 })).map(
          (row) => row.id,
        ),
      ).toEqual([note.id]);

      const updated = await store.updatePlayerNote(note.id, { watch: false });
      expect(updated).toMatchObject({ watch: false, note: 'smurf' });
      expect(await store.deletePlayerNote(note.id)).toBe(true);
      expect(await store.deletePlayerNote(note.id)).toBe(false);
    });
  });

  describe('server snapshots', () => {
    it("lists a server's snapshots oldest first and prunes old ones", async () => {
      const row = {
        online: true,
        playerCount: 3,
        maxClients: 40,
        map: 'mp_toujane',
        gametype: 'ctf',
      };
      await store.recordServerSnapshot({ serverAlias: 'a', ...row });
      await store.recordServerSnapshot({
        serverAlias: 'a',
        ...row,
        playerCount: 4,
      });
      await store.recordServerSnapshot({ serverAlias: 'b', ...row });
      await pool.query(
        "UPDATE server_snapshots SET at = now() - interval '40 days' WHERE player_count = 3 AND server_alias = 'a'",
      );

      const recent = await store.listServerSnapshots(
        'a',
        new Date(Date.now() - 86_400_000),
      );
      expect(recent.map((snapshot) => snapshot.playerCount)).toEqual([4]);

      await store.pruneServerSnapshots(new Date(Date.now() - 30 * 86_400_000));
      expect(await store.listServerSnapshots('a', new Date(0))).toHaveLength(1);
    });
  });
});
