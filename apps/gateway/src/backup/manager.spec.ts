import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminStore } from '@cod2admin/admin-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupManager, type BackupSender } from './manager.js';
import { DEFAULT_SCHEDULE } from './schedule.js';
import type { BackupService, CreatedBackup } from './service.js';

const PASS = 'a long enough passphrase';
const OWNER = 4242;

function fakeStore(): AdminStore {
  const settings = new Map<string, unknown>();
  return {
    getSetting: async (key: string) => settings.get(key),
    setSetting: async (key: string, value: unknown) => {
      settings.set(key, JSON.parse(JSON.stringify(value)));
    },
    deleteSetting: async (key: string) => {
      settings.delete(key);
    },
    listAdmins: async () => [{ telegramId: OWNER, isOwner: true }],
  } as unknown as AdminStore;
}

describe('BackupManager', () => {
  let dir: string;
  let clock: Date;
  let sent: Array<{
    kind: 'doc' | 'msg';
    to: number;
    text: string;
    path?: string;
  }>;
  let failSends: number;
  const sender: BackupSender = {
    async sendDocument(to, path, text) {
      if (failSends > 0) {
        failSends--;
        throw new Error('relay down');
      }
      sent.push({ kind: 'doc', to, text, path });
    },
    async sendMessage(to, text) {
      sent.push({ kind: 'msg', to, text });
    },
  };
  // Sizes by group set, so the over-limit paths can be driven without real data.
  let sizeOf: (groups: readonly string[]) => number;
  const calls: string[][] = [];
  const service = {
    async createFile({
      groups,
      prefix = 'cod2admin',
    }: {
      groups: readonly string[];
      prefix?: string;
    }) {
      calls.push([...groups]);
      const name = `${prefix}-${String(calls.length).padStart(8, '0')}-000000.c2bak`;
      const path = join(dir, name);
      const bytes = sizeOf(groups);
      await writeFile(path, Buffer.alloc(bytes, 1));
      return {
        path,
        name,
        bytes,
        counts: { admins: 1 },
      } satisfies CreatedBackup;
    },
    async prune(keep: number) {
      const files = (await readdir(dir))
        .filter((n) => n.startsWith('cod2admin-'))
        .sort()
        .reverse();
      for (const f of files.slice(keep)) await rm(join(dir, f));
      return 0;
    },
  } as unknown as BackupService;

  const make = (
    extra: Partial<ConstructorParameters<typeof BackupManager>[0]> = {},
  ) =>
    new BackupManager({
      adminStore: fakeStore(),
      service,
      secretsKey: randomBytes(32).toString('base64'),
      sender,
      now: () => clock,
      sleep: async () => undefined,
      ...extra,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mgr-'));
    clock = new Date('2026-11-21T04:00:30');
    sent = [];
    failSends = 0;
    sizeOf = () => 100;
    calls.length = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function enabled(manager: BackupManager, patch = {}) {
    await manager.setPassphrase(PASS);
    clock = new Date('2026-11-20T10:00:00');
    await manager.setSchedule({ ...DEFAULT_SCHEDULE, enabled: true, ...patch });
    clock = new Date('2026-11-21T04:00:30');
  }

  it('refuses to turn on without a passphrase, and stores the passphrase encrypted', async () => {
    const manager = make();
    await expect(
      manager.setSchedule({ ...DEFAULT_SCHEDULE, enabled: true }),
    ).rejects.toThrow(/passphrase/);
    await manager.setPassphrase(PASS);
    expect(await manager.getPassphrase()).toBe(PASS);
    const stored = JSON.stringify(
      await (
        manager as unknown as { options: { adminStore: AdminStore } }
      ).options.adminStore.getSetting('backup.passphrase'),
    );
    expect(stored).not.toContain(PASS);
    await expect(make().setPassphrase('short')).rejects.toThrow();
  });

  it('sends the file to the owner’s private chat when due, then not again', async () => {
    const manager = make();
    await enabled(manager);
    expect(await manager.tick()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'doc', to: OWNER });
    expect(sent[0].text).toContain('passphrase');
    expect(sent[0].text).not.toContain(PASS);
    expect(await manager.tick()).toBe(false);
    expect((await manager.getLastRun())?.ok).toBe(true);
  });

  it('retries a failed send, and tells the owner when every try fails, keeping the host copy', async () => {
    const manager = make();
    await enabled(manager);
    failSends = 2;
    await manager.runNow();
    expect(sent.filter((s) => s.kind === 'doc')).toHaveLength(1);

    failSends = 5;
    sent = [];
    const run = await manager.runNow();
    expect(run.ok).toBe(false);
    expect(sent.at(-1)).toMatchObject({ kind: 'msg', to: OWNER });
    expect(sent.at(-1)?.text).toMatch(/Backup failed/);
    expect((await readdir(dir)).some((n) => n.startsWith('cod2admin-'))).toBe(
      true,
    );
    expect((await manager.getLastRun())?.ok).toBe(false);
  });

  it('drops watch, then history, when the file is over the limit, and splits if still too big', async () => {
    const manager = make({ partBytes: 1000 });
    await enabled(manager, { groups: ['core', 'history', 'watch'] });
    sizeOf = (groups) =>
      groups.includes('watch') ? 5000 : groups.includes('history') ? 2500 : 600;
    await manager.runNow();
    expect(calls.at(-1)).toEqual(['core']);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('without history');

    sent = [];
    sizeOf = () => 2500;
    await manager.runNow();
    expect(sent.filter((s) => s.kind === 'doc').length).toBeGreaterThan(1);
    expect(sent[0].text).toContain('part 1 of');
    // Temporary parts and smaller copies are gone; only host copies remain.
    const left = await readdir(dir);
    expect(left.every((n) => /^cod2admin-\d+-\d+\.c2bak$/.test(n))).toBe(true);
  });

  it('sends only a message in notify mode, and nothing when telegram is off', async () => {
    const manager = make();
    await enabled(manager, { telegram: 'notify' });
    await manager.runNow();
    expect(sent.map((s) => s.kind)).toEqual(['msg']);
    sent = [];
    await manager.setSchedule({
      ...DEFAULT_SCHEDULE,
      enabled: true,
      telegram: 'off',
    });
    await manager.runNow();
    expect(sent).toEqual([]);
  });

  it('keeps only keepLocal files on the host', async () => {
    const manager = make();
    await enabled(manager, { keepLocal: 2 });
    for (let i = 0; i < 4; i++) await manager.runNow();
    const files = (await readdir(dir)).filter((n) =>
      n.startsWith('cod2admin-'),
    );
    expect(files).toHaveLength(2);
    expect((await stat(join(dir, files[0]))).size).toBe(100);
  });

  it('does not run twice at once, and turning the passphrase off turns the schedule off', async () => {
    const manager = make();
    await enabled(manager);
    const [a, b] = await Promise.all([manager.runNow(), manager.runNow()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    await manager.setPassphrase(null);
    expect((await manager.getSchedule()).enabled).toBe(false);
  });

  it('uses BACKUP_PASSPHRASE over a saved one and refuses to change it', async () => {
    const manager = make({ envPassphrase: 'from the environment!' });
    expect(await manager.getPassphrase()).toBe('from the environment!');
    await expect(manager.setPassphrase(PASS)).rejects.toThrow(/config/);
  });
});
