import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate as migrateAdmin, type Permission } from '@cod2admin/admin-store';
import { migrate as migrateBan } from '@cod2admin/ban-store';
import { Pool } from '@cod2admin/backup';
import { migrate as migrateWatch } from '@cod2admin/watch-store';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BackupManager } from '../backup/manager.js';
import { createBackupService } from '../backup/service.js';
import { OWNER_ACCESS, sampleAdmin } from '../lib/testing/fake-admin-store.js';
import { createFakeDeps, type FakeDeps } from '../lib/testing/fake-deps.js';
import { signInitData } from './init-data.js';
import { createMiniAppServer } from './server.js';

const TOKEN = '123456:TEST-token';
const OWNER = 1;
const STAFF = 2;
const PASS = 'a long enough passphrase';
const BASE =
  process.env.DATABASE_URL ??
  'postgres://cod2admin:dev_password_change_me@127.0.0.1:5432/cod2admin_dev';

function auth(id: number) {
  const initData = signInitData(
    {
      user: JSON.stringify({ id, username: 'kim', first_name: 'Kim' }),
      auth_date: String(Math.floor(Date.now() / 1000)),
    },
    TOKEN,
  );
  return { authorization: `tma ${initData}` };
}

describe('Mini App backup routes', () => {
  let admin: Pool;
  let dbName: string;
  let dbUrl: string;
  let pool: Pool;
  let dir: string;
  let app: FastifyInstance | undefined;
  let fake: FakeDeps;
  let restarts: number;
  let documents: Array<{ to: number; path: string }>;

  beforeAll(async () => {
    dbName = `c2bak_routes_${randomBytes(4).toString('hex')}`;
    admin = new Pool({ connectionString: BASE });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(BASE);
    url.pathname = `/${dbName}`;
    dbUrl = url.toString();
    await migrateAdmin(dbUrl);
    await migrateBan(dbUrl);
    await migrateWatch(dbUrl);
    pool = new Pool({ connectionString: dbUrl });
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'routes-backup-'));
    restarts = 0;
    documents = [];
    await pool.query('TRUNCATE bans, admins RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO bans (server_alias, name, banned_by) VALUES ('main', 'Cheater', 1)`,
    );
    fake = createFakeDeps();
    const settings = new Map<string, unknown>();
    fake.adminStore.getSetting.mockImplementation(async (k) => settings.get(k));
    fake.adminStore.setSetting.mockImplementation(async (k, v) => {
      settings.set(k, JSON.parse(JSON.stringify(v)));
    });
    fake.adminStore.deleteSetting.mockImplementation(async (k) => {
      settings.delete(k);
    });
    const shapes: Record<number, { isOwner: boolean; permissions: Permission[] }> = {
      [OWNER]: OWNER_ACCESS,
      [STAFF]: { isOwner: false, permissions: ['kick', 'ban'] },
    };
    const admins = Object.entries(shapes).map(([id, access]) =>
      sampleAdmin({ telegramId: Number(id), ...access }),
    );
    fake.adminStore.getAdmin.mockImplementation(async (id) =>
      admins.find((a) => a.telegramId === id),
    );
    fake.adminStore.listAdmins.mockResolvedValue(admins);
    const service = createBackupService({
      databaseUrl: dbUrl,
      secretsKey: randomBytes(32).toString('base64'),
      appVersion: 'test',
      dir,
    });
    fake.deps.backup = new BackupManager({
      adminStore: fake.adminStore,
      service,
      secretsKey: randomBytes(32).toString('base64'),
      sender: {
        sendDocument: async (to, path) => {
          documents.push({ to, path });
        },
        sendMessage: async () => undefined,
      },
      restart: () => {
        restarts++;
      },
    });
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    await fake.deps.backup?.service.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    as: number,
    payload?: object | Buffer,
    contentType?: string,
  ) {
    app ??= await createMiniAppServer(fake.deps, { botToken: TOKEN });
    return app.inject({
      method,
      url: `/api${url}`,
      headers: {
        ...auth(as),
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  }

  it('is closed to anyone without backup.manage', async () => {
    for (const [method, url] of [
      ['GET', '/backup'],
      ['POST', '/backup/files'],
      ['PUT', '/backup/schedule'],
      ['PUT', '/backup/passphrase'],
      ['POST', '/backup/restore'],
      ['GET', '/backup/files/cod2admin-20260101-000000.c2bak'],
    ] as const) {
      expect((await call(method, url, STAFF, {})).statusCode).toBe(403);
    }
  });

  it('exports, downloads, and restores a file, and writes no passphrase to the audit log', async () => {
    const made = await call('POST', '/backup/files', OWNER, {
      passphrase: PASS,
      groups: ['core', 'bans'],
    });
    expect(made.statusCode).toBe(200);
    const { name } = made.json<{ name: string }>();
    expect(name).toMatch(/^manual-\d{8}-\d{6}\.c2bak$/);

    const download = await call('GET', `/backup/files/${name}`, OWNER);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.subarray(0, 5).toString('latin1')).toBe('C2BAK');
    expect(download.rawPayload.includes('Cheater')).toBe(false);

    await pool.query('TRUNCATE bans RESTART IDENTITY CASCADE');
    const preview = await call('POST', '/backup/preview', OWNER, {
      source: { file: name },
      passphrase: PASS,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json<{ tables: { name: string; fileRows: number; currentRows: number }[] }>().tables.find((t) => t.name === 'bans')).toMatchObject({ fileRows: 1, currentRows: 0 });

    const noConfirm = await call('POST', '/backup/restore', OWNER, {
      source: { file: name },
      passphrase: PASS,
      confirm: 'yes',
    });
    expect(noConfirm.statusCode).toBe(400);

    const restored = await call('POST', '/backup/restore', OWNER, {
      source: { file: name },
      passphrase: PASS,
      confirm: 'REPLACE',
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<{ snapshot: string }>().snapshot).toMatch(/^pre-import-/);
    const { rows } = await pool.query('SELECT name FROM bans');
    expect(rows).toEqual([{ name: 'Cheater' }]);
    await new Promise((r) => setTimeout(r, 1700));
    expect(restarts).toBe(1);

    const logged = JSON.stringify(fake.adminStore.recordAuditLog.mock.calls);
    expect(logged).not.toContain(PASS);
    expect(logged).toContain('backuprestore');
  });

  it('restores an uploaded file and removes the upload', async () => {
    const made = await call('POST', '/backup/files', OWNER, { passphrase: PASS, groups: ['core', 'bans'] });
    const { name } = made.json<{ name: string }>();
    const bytes = (await call('GET', `/backup/files/${name}`, OWNER)).rawPayload;
    const upload = await call('POST', '/backup/uploads', OWNER, bytes, 'application/octet-stream');
    expect(upload.statusCode).toBe(200);
    const { upload: id } = upload.json<{ upload: string }>();
    await pool.query('TRUNCATE bans RESTART IDENTITY CASCADE');
    const restored = await call('POST', '/backup/restore', OWNER, {
      source: { upload: id },
      passphrase: PASS,
      confirm: 'REPLACE',
    });
    expect(restored.statusCode).toBe(200);
    expect((await readdir(dir)).some((n) => n.startsWith('upload-'))).toBe(false);
    expect((await pool.query('SELECT count(*) AS n FROM bans')).rows[0].n).toBe('1');
  });

  it('refuses a wrong passphrase and a junk upload without changing anything', async () => {
    const made = await call('POST', '/backup/files', OWNER, { passphrase: PASS, groups: ['core', 'bans'] });
    const { name } = made.json<{ name: string }>();
    await pool.query('TRUNCATE bans RESTART IDENTITY CASCADE');
    const wrong = await call('POST', '/backup/restore', OWNER, {
      source: { file: name },
      passphrase: 'not the right one',
      confirm: 'REPLACE',
    });
    expect(wrong.statusCode).toBe(400);
    const upload = await call('POST', '/backup/uploads', OWNER, Buffer.from('not a backup at all'), 'application/octet-stream');
    const { upload: id } = upload.json<{ upload: string }>();
    const junk = await call('POST', '/backup/preview', OWNER, { source: { upload: id }, passphrase: PASS });
    expect(junk.statusCode).toBe(400);
    expect(restarts).toBe(0);
    expect((await pool.query('SELECT count(*) AS n FROM bans')).rows[0].n).toBe('0');
  });

  it('rejects names that are not backup files', async () => {
    for (const name of ['..%2F..%2Fetc%2Fpasswd', 'x.txt', 'manual-1.c2bak']) {
      expect((await call('GET', `/backup/files/${name}`, OWNER)).statusCode).toBe(404);
      expect((await call('DELETE', `/backup/files/${name}`, OWNER)).statusCode).toBe(404);
    }
    const bad = await call('POST', '/backup/preview', OWNER, { source: { file: '../x' }, passphrase: PASS });
    expect(bad.statusCode).toBe(404);
    await writeFile(join(dir, 'keep.txt'), 'x');
  });

  it('saves a schedule only once a passphrase is set, and shows status without the passphrase', async () => {
    const schedule = { enabled: true, mode: 'daily', at: '03:30', hours: 24, groups: ['core', 'bans'], telegram: 'file', keepLocal: 3 };
    expect((await call('PUT', '/backup/schedule', OWNER, schedule)).statusCode).toBe(400);
    expect((await call('PUT', '/backup/passphrase', OWNER, { passphrase: 'short' })).statusCode).toBe(400);
    expect((await call('PUT', '/backup/passphrase', OWNER, { passphrase: PASS })).statusCode).toBe(200);
    expect((await call('PUT', '/backup/schedule', OWNER, schedule)).statusCode).toBe(200);
    const status = await call('GET', '/backup', OWNER);
    const body = status.json<{ schedule: { at: string }; passphraseSet: boolean }>();
    expect(body.schedule.at).toBe('03:30');
    expect(body.passphraseSet).toBe(true);
    expect(status.body).not.toContain(PASS);
    expect(JSON.stringify(fake.adminStore.recordAuditLog.mock.calls)).not.toContain(PASS);
  });

  it('sends a file to the requester’s own chat', async () => {
    const made = await call('POST', '/backup/files', OWNER, { passphrase: PASS, groups: ['core'] });
    const { name } = made.json<{ name: string }>();
    const sent = await call('POST', `/backup/files/${name}/send`, OWNER);
    expect(sent.statusCode).toBe(200);
    expect(documents).toEqual([{ to: OWNER, path: join(dir, name) }]);
  });
});
