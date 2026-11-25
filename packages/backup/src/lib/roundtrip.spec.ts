import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { createAdminStore, SecretBox } from '@cod2admin/admin-store';
import { createBanStore } from '@cod2admin/ban-store';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptStream } from './crypto.js';
import { exportBackup, exportBackupToFile } from './export.js';
import { restoreBackup } from './import.js';
import { joinParts, splitFile } from './parts.js';
import { createScratchDb, type ScratchDb } from './testing-db.js';
import { BackupError } from './format.js';
import { DEFAULT_GROUPS } from './registry.js';

const PASS = 'a long enough passphrase';
const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');

async function bytes(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of stream) out.push(chunk);
  return Buffer.concat(out);
}

describe('backup round trip', () => {
  let db: ScratchDb;
  let dir: string;
  const boxA = () => new SecretBox(keyA);
  const boxB = () => new SecretBox(keyB);

  beforeAll(async () => {
    db = await createScratchDb();
    dir = await mkdtemp(join(tmpdir(), 'c2bak-'));
  });
  afterAll(async () => {
    await db.drop();
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(): Promise<void> {
    await db.pool.query(
      'TRUNCATE admins, servers, settings, bans, ban_ips, mutes, audit_log, reports, player_notes, server_snapshots, custom_functions, telegram_users RESTART IDENTITY CASCADE',
    );
    const admin = createAdminStore(db.url, keyA);
    const bans = createBanStore(db.url);
    try {
      await admin.claimOwner(1001);
      await admin.addAdmin(1002, ['kick', 'ban'], 1001);
      await admin.upsertServer({
        alias: 'main',
        rconHost: '10.0.0.5',
        rconPort: 28960,
        rconPassword: 'rcon-secret-Привет',
        logSourceConfig: '/var/log/cod2.log',
      });
      await admin.setDefaultServer('main');
      await admin.setSetting('relays', { list: ['a', 'b'], arr: [1, 2] });
      await admin.setSetting('backup.passphrase', 'host-only');
      for (let i = 0; i < 3; i++) {
        await admin.recordAuditLog({
          actorTelegramId: 1001,
          action: 'kick',
          target: `Игрок ${i}`,
          serverAlias: 'main',
          source: 'miniapp',
          detailJson: i === 1 ? [1, 'two', { three: 3 }] : { i },
        });
      }
      await bans.recordBan({
        serverAlias: 'main',
        name: 'Cheater',
        guid: '12345',
        reason: 'aim',
        bannedBy: 1001,
      });
      await bans.recordIpBan({
        serverAlias: 'main',
        ip: '203.0.113.9',
        reason: 'evasion',
        bannedBy: 1001,
        expiresAt: new Date('2030-01-01T00:00:00.123456Z'),
      });
    } finally {
      await admin.close();
      await bans.close();
    }
  }

  async function snapshot(): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    for (const table of [
      'admins',
      'admin_permissions',
      'servers',
      'settings',
      'bans',
      'ban_ips',
      'audit_log',
    ]) {
      const { rows } = await db.pool.query(
        `SELECT * FROM ${table} ORDER BY 1, 2`,
      );
      // Every encryption uses a fresh IV, so compare what the secret says, not its ciphertext.
      out[table] = rows.map((row) =>
        table === 'servers'
          ? {
              ...row,
              rcon_password_encrypted: boxA().decrypt(
                row.rcon_password_encrypted,
              ),
            }
          : row,
      );
    }
    return out;
  }

  beforeEach(seed);

  const exportAll = (secrets = boxA()) =>
    exportBackup({
      pool: db.pool,
      groups: DEFAULT_GROUPS,
      passphrase: PASS,
      secrets,
      appVersion: 'test',
    });

  it('restores every row, including jsonb, microseconds and the secret', async () => {
    const before = await snapshot();
    const file = await bytes(exportAll());

    await db.pool.query(
      'TRUNCATE admins, servers, settings, bans, ban_ips, audit_log RESTART IDENTITY CASCADE',
    );
    const report = await restoreBackup({
      pool: db.pool,
      source: Readable.from([file]),
      passphrase: PASS,
      secrets: boxA(),
    });

    expect(report.applied).toBe(true);
    const after = await snapshot();
    // The host-only row is neither exported nor restored.
    before.settings = before.settings.filter(
      (row) => (row as { key: string }).key !== 'backup.passphrase',
    );
    expect(after).toEqual(before);
  });

  it('keeps the host-only setting and does not export it', async () => {
    const file = await bytes(exportAll());
    await restoreBackup({
      pool: db.pool,
      source: Readable.from([file]),
      passphrase: PASS,
      secrets: boxA(),
    });
    const { rows } = await db.pool.query(
      `SELECT value FROM settings WHERE key = 'backup.passphrase'`,
    );
    expect(rows).toEqual([{ value: 'host-only' }]);
  });

  it('re-encrypts secrets for a host with a different key', async () => {
    const file = await bytes(exportAll());
    await restoreBackup({
      pool: db.pool,
      source: Readable.from([file]),
      passphrase: PASS,
      secrets: boxB(),
    });
    const admin = createAdminStore(db.url, keyB);
    try {
      const server = await admin.getServer('main');
      expect(server?.rconPassword).toBe('rcon-secret-Привет');
    } finally {
      await admin.close();
    }
  });

  it('continues sequences after the import', async () => {
    const file = await bytes(exportAll());
    await restoreBackup({
      pool: db.pool,
      source: Readable.from([file]),
      passphrase: PASS,
      secrets: boxA(),
    });
    const admin = createAdminStore(db.url, keyA);
    try {
      await admin.recordAuditLog({
        actorTelegramId: 1001,
        action: 'after',
        source: 'auto',
      });
      const { rows } = await db.pool.query(
        `SELECT max(id) AS max, count(*) AS n FROM audit_log`,
      );
      expect(Number(rows[0].n)).toBe(4);
      expect(Number(rows[0].max)).toBe(4);
    } finally {
      await admin.close();
    }
  });

  it('dry run reports counts and writes nothing', async () => {
    const file = await bytes(exportAll());
    await db.pool.query('TRUNCATE bans, ban_ips RESTART IDENTITY CASCADE');
    const report = await restoreBackup({
      pool: db.pool,
      source: Readable.from([file]),
      passphrase: PASS,
      secrets: boxA(),
      dryRun: true,
    });
    expect(report.applied).toBe(false);
    const bansRow = report.tables.find((t) => t.name === 'bans');
    expect(bansRow).toMatchObject({ fileRows: 1, currentRows: 0 });
    const { rows } = await db.pool.query('SELECT count(*) AS n FROM bans');
    expect(Number(rows[0].n)).toBe(0);
  });

  it('refuses a wrong passphrase, a damaged file and a cut-off file without writing', async () => {
    const file = await bytes(exportAll());
    const flipped = Buffer.from(file);
    flipped[flipped.length - 30] ^= 1;
    const cases: Array<[Buffer, string]> = [
      [file, 'wrong passphrase!!'],
      [flipped, PASS],
      [file.subarray(0, file.length - 40), PASS],
    ];
    for (const [data, passphrase] of cases) {
      await expect(
        restoreBackup({
          pool: db.pool,
          source: Readable.from([data]),
          passphrase,
          secrets: boxA(),
        }),
      ).rejects.toThrow();
      const { rows } = await db.pool.query('SELECT count(*) AS n FROM bans');
      expect(Number(rows[0].n)).toBe(1);
    }
  });

  it('refuses to restore servers without the secrets key, and leaves the data alone', async () => {
    const file = await bytes(exportAll());
    await expect(
      restoreBackup({
        pool: db.pool,
        source: Readable.from([file]),
        passphrase: PASS,
      }),
    ).rejects.toThrow(BackupError);
    const { rows } = await db.pool.query('SELECT count(*) AS n FROM servers');
    expect(Number(rows[0].n)).toBe(1);
  });

  it('rolls back everything when a row fails after the tables were emptied', async () => {
    const manifest = {
      t: 'manifest',
      format: 1,
      app: 'test',
      created: new Date().toISOString(),
      groups: ['bans'],
      tables: [
        {
          name: 'bans',
          group: 'bans',
          columns: ['id', 'server_alias', 'name', 'banned_by'],
        },
      ],
    };
    const rows = [
      { t: 'r', n: 'bans', v: [50, 'main', 'A', '1'] },
      { t: 'r', n: 'bans', v: [50, 'main', 'B', '1'] },
    ];
    const text = [manifest, ...rows, { t: 'end', counts: { bans: 2 } }]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const gz = gzipSync(Buffer.from(text));
    const file = await bytes(encryptStream(Readable.from([gz]), PASS));
    await expect(
      restoreBackup({
        pool: db.pool,
        source: Readable.from([file]),
        passphrase: PASS,
      }),
    ).rejects.toThrow();
    const { rows: left } = await db.pool.query('SELECT name FROM bans');
    expect(left).toEqual([{ name: 'Cheater' }]);
  });

  it('drops columns this version no longer has, and reports it', async () => {
    const manifest = {
      t: 'manifest',
      format: 1,
      app: 'old',
      created: new Date().toISOString(),
      groups: ['bans'],
      tables: [
        {
          name: 'bans',
          group: 'bans',
          columns: [
            'id',
            'server_alias',
            'name',
            'banned_by',
            'removed_column',
          ],
        },
      ],
    };
    const text = [
      manifest,
      { t: 'r', n: 'bans', v: [7, 'main', 'Old', '1', 'x'] },
      { t: 'end', counts: { bans: 1 } },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const file = await bytes(
      encryptStream(Readable.from([gzipSync(Buffer.from(text))]), PASS),
    );
    const report = await restoreBackup({
      pool: db.pool,
      source: Readable.from([file]),
      passphrase: PASS,
    });
    expect(report.warnings.join(' ')).toContain('removed_column');
    const { rows } = await db.pool.query('SELECT id, name FROM bans');
    expect(rows).toEqual([{ id: 7, name: 'Old' }]);
  });

  it('refuses a file from a newer format', async () => {
    const text = JSON.stringify({
      t: 'manifest',
      format: 99,
      app: 'future',
      created: '',
      groups: [],
      tables: [],
    });
    const file = await bytes(
      encryptStream(Readable.from([gzipSync(Buffer.from(text))]), PASS),
    );
    await expect(
      restoreBackup({
        pool: db.pool,
        source: Readable.from([file]),
        passphrase: PASS,
      }),
    ).rejects.toThrow(/newer version/);
  });

  it('writes a private file and imports it back from a file and from split parts', async () => {
    const path = join(dir, 'a.c2bak');
    const result = await exportBackupToFile(
      {
        pool: db.pool,
        groups: DEFAULT_GROUPS,
        passphrase: PASS,
        secrets: boxA(),
        appVersion: 'test',
      },
      path,
    );
    expect(result.counts.audit_log).toBe(3);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600');
    expect((await readFile(path)).includes('203.0.113.9')).toBe(false);

    const parts = await splitFile(path, 300);
    expect(parts.length).toBeGreaterThan(1);
    await db.pool.query('TRUNCATE bans, ban_ips RESTART IDENTITY CASCADE');
    const report = await restoreBackup({
      pool: db.pool,
      source: joinParts(parts),
      passphrase: PASS,
      secrets: boxA(),
      groups: ['bans'],
    });
    expect(report.tables.map((t) => t.name).sort()).toEqual([
      'ban_ips',
      'bans',
      'mutes',
    ]);
    const { rows } = await db.pool.query('SELECT count(*) AS n FROM ban_ips');
    expect(Number(rows[0].n)).toBe(1);
  });

  it('restores only the chosen group and leaves the rest alone', async () => {
    const file = await bytes(exportAll());
    await db.pool.query('DELETE FROM audit_log');
    await db.pool.query('TRUNCATE bans RESTART IDENTITY CASCADE');
    await restoreBackup({
      pool: db.pool,
      source: Readable.from([file]),
      passphrase: PASS,
      groups: ['bans'],
    });
    const bans = await db.pool.query('SELECT count(*) AS n FROM bans');
    const audit = await db.pool.query('SELECT count(*) AS n FROM audit_log');
    expect(Number(bans.rows[0].n)).toBe(1);
    expect(Number(audit.rows[0].n)).toBe(0);
  });
});
