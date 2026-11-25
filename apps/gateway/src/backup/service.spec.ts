import { describe, expect, it } from 'vitest';
import { backupDirFromEnv } from './service.js';

const fs = (exists: boolean, writable: boolean) => ({
  exists: () => exists,
  writable: () => writable,
});

describe('backupDirFromEnv', () => {
  it('uses BACKUP_DIR when set', () => {
    expect(
      backupDirFromEnv(
        { BACKUP_DIR: '/b', UPDATE_STAGING_DIR: '/o/staging' },
        fs(false, false),
      ),
    ).toBe('/b');
  });
  it('uses the folder beside staging when it exists or can be created', () => {
    const env = { UPDATE_STAGING_DIR: '/opt/cod2admin/staging' };
    expect(backupDirFromEnv(env, fs(true, false))).toBe(
      '/opt/cod2admin/backups',
    );
    expect(backupDirFromEnv(env, fs(false, true))).toBe(
      '/opt/cod2admin/backups',
    );
  });
  it('falls back to staging/backups when the install folder is root-owned and has none', () => {
    expect(
      backupDirFromEnv(
        { UPDATE_STAGING_DIR: '/opt/cod2admin/staging' },
        fs(false, false),
      ),
    ).toBe('/opt/cod2admin/staging/backups');
  });
});
