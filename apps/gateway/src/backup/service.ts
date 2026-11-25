import { accessSync, constants, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { SecretBox } from '@cod2admin/admin-store';
import {
  Pool,
  exportBackupToFile,
  restoreBackup,
  type BackupGroup,
  type RestoreReport,
} from '@cod2admin/backup';

export interface BackupFileInfo {
  name: string;
  bytes: number;
  modifiedAt: Date;
}

export interface CreatedBackup {
  path: string;
  name: string;
  bytes: number;
  counts: Record<string, number>;
}

/**
 * `BACKUP_DIR`, else a `backups` folder beside the update staging folder (outside the release dir).
 * The bot's own user cannot create that folder in an install folder owned by root (an install that
 * was updated rather than re-installed has none), so then it falls back to `staging/backups`, which
 * the bot owns.
 */
export function backupDirFromEnv(
  env: NodeJS.ProcessEnv,
  fs: {
    exists(path: string): boolean;
    writable(path: string): boolean;
  } = {
    exists: existsSync,
    writable: (path) => {
      try {
        accessSync(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  },
): string {
  if (env.BACKUP_DIR) return env.BACKUP_DIR;
  const staging = env.UPDATE_STAGING_DIR;
  if (!staging) return join(process.cwd(), 'backups');
  const beside = join(dirname(staging), 'backups');
  if (fs.exists(beside) || fs.writable(dirname(staging))) return beside;
  return join(staging, 'backups');
}

const stamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-');

/** Backup files that this service writes and prunes, and nothing else in the folder. */
export const BACKUP_FILE_NAME =
  /^(cod2admin|pre-import|send|manual)-\d{8}-\d{6}\.c2bak$/;

/** `cod2admin`: scheduled. `manual`: made on the Backup page. `pre-import`: before a restore. `send`: a smaller copy for Telegram. */
export type BackupPrefix = 'cod2admin' | 'manual' | 'pre-import' | 'send';

export interface BackupService {
  readonly dir: string;
  readonly pool: Pool;
  createFile(input: {
    groups: readonly BackupGroup[];
    passphrase: string;
    prefix?: BackupPrefix;
  }): Promise<CreatedBackup>;
  list(): Promise<BackupFileInfo[]>;
  /** Deletes all but the newest `keep` files of `prefix`. */
  prune(keep: number, prefix?: BackupPrefix): Promise<number>;
  preview(path: string, passphrase: string): Promise<RestoreReport>;
  restore(
    path: string,
    passphrase: string,
    groups?: readonly BackupGroup[],
  ): Promise<RestoreReport>;
  close(): Promise<void>;
}

export function createBackupService(options: {
  databaseUrl: string;
  secretsKey: string;
  appVersion: string;
  dir: string;
  now?: () => Date;
}): BackupService {
  const pool = new Pool({ connectionString: options.databaseUrl });
  const secrets = new SecretBox(options.secretsKey);
  const now = options.now ?? (() => new Date());

  const list = async (): Promise<BackupFileInfo[]> => {
    let names: string[];
    try {
      names = await readdir(options.dir);
    } catch {
      return [];
    }
    const out: BackupFileInfo[] = [];
    for (const name of names.filter((n) => BACKUP_FILE_NAME.test(n))) {
      const info = await stat(join(options.dir, name));
      out.push({ name, bytes: info.size, modifiedAt: info.mtime });
    }
    return out.sort((a, b) => b.name.localeCompare(a.name));
  };

  return {
    dir: options.dir,
    pool,
    async createFile({ groups, passphrase, prefix = 'cod2admin' }) {
      await mkdir(options.dir, { recursive: true, mode: 0o700 });
      const name = `${prefix}-${stamp(now())}.c2bak`;
      const path = join(options.dir, name);
      const partial = `${path}.partial`;
      try {
        const { bytes, counts } = await exportBackupToFile(
          {
            pool,
            groups,
            passphrase,
            secrets,
            appVersion: options.appVersion,
            now,
          },
          partial,
        );
        await rename(partial, path);
        return { path, name, bytes, counts };
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }
    },
    list,
    async prune(keep, prefix = 'cod2admin') {
      const mine = (await list()).filter((f) =>
        f.name.startsWith(`${prefix}-`),
      );
      const old = mine.slice(Math.max(0, keep));
      for (const file of old)
        await rm(join(options.dir, file.name), { force: true });
      return old.length;
    },
    preview: (path, passphrase) =>
      restoreBackup({
        pool,
        source: createReadStream(path),
        passphrase,
        secrets,
        dryRun: true,
      }),
    restore: (path, passphrase, groups) =>
      restoreBackup({
        pool,
        source: createReadStream(path),
        passphrase,
        secrets,
        groups,
      }),
    close: () => pool.end(),
  };
}
