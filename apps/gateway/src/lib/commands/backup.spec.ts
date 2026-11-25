import { describe, expect, it, vi } from 'vitest';
import type { BackupManager } from '../../backup/manager.js';
import { DEFAULT_SCHEDULE, validateSchedule } from '../../backup/schedule.js';
import { OWNER_ACCESS } from '../testing/fake-admin-store.js';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { backupCommand } from './backup.js';

function setup(passphrase: string | null = 'x'.repeat(12)) {
  const fake = createFakeDeps();
  let schedule = { ...DEFAULT_SCHEDULE };
  const manager = {
    getSchedule: vi.fn(async () => schedule),
    setSchedule: vi.fn(async (next: unknown) => {
      if (
        (next as { enabled: boolean }).enabled &&
        !passphrase
      ) {
        const { BackupCryptoError } = await import('@cod2admin/backup');
        throw new BackupCryptoError('Set a backup passphrase before turning the schedule on.');
      }
      schedule = validateSchedule(next);
      return schedule;
    }),
    getPassphrase: vi.fn(async () => passphrase ?? undefined),
    getLastRun: vi.fn(async () => null),
    runNow: vi.fn(async () => ({ at: 'now', ok: true, message: 'Saved x.' })),
  };
  fake.deps.backup = manager as unknown as BackupManager;
  return { fake, manager };
}

const ctx = (match: string) =>
  createFakeCtx({ match, admin: { telegramId: 1, ...OWNER_ACCESS } });
const replies = (c: ReturnType<typeof ctx>) =>
  vi.mocked(c.reply).mock.calls.map((call) => String(call[0])).join('\n');

describe('backupCommand', () => {
  it('shows the schedule, passphrase state and no secret', async () => {
    const { fake } = setup();
    const c = ctx('');
    await backupCommand(c, fake.deps);
    expect(replies(c)).toContain('Scheduled backup: off');
    expect(replies(c)).toContain('Passphrase: set');
    expect(replies(c)).not.toContain('xxxxxxxxxxxx');
  });

  it('turns the schedule on and off and audits it', async () => {
    const { fake, manager } = setup();
    const on = ctx('on daily 03:15');
    await backupCommand(on, fake.deps);
    expect(replies(on)).toContain('every day at 03:15');
    const every = ctx('on every 6');
    await backupCommand(every, fake.deps);
    expect(replies(every)).toContain('every 6 hours');
    const off = ctx('off');
    await backupCommand(off, fake.deps);
    expect(manager.setSchedule).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(fake.adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'backupschedule', source: 'telegram_command' }),
    );
  });

  it('says so, instead of failing, when there is no passphrase or the time is wrong', async () => {
    const none = setup(null);
    const c = ctx('on daily 04:00');
    await backupCommand(c, none.fake.deps);
    expect(replies(c)).toContain('passphrase');
    const ok = setup();
    const bad = ctx('on daily 4am');
    await backupCommand(bad, ok.fake.deps);
    expect(replies(bad)).toContain('The time must look like');
  });

  it('runs a backup now', async () => {
    const { fake, manager } = setup();
    const c = ctx('now');
    await backupCommand(c, fake.deps);
    expect(manager.runNow).toHaveBeenCalled();
    expect(replies(c)).toContain('Saved x.');
  });
});
