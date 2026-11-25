import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  BackupCryptoError,
  BackupError,
  DEFAULT_GROUPS,
  exportBackupToFile,
  isGatewayRunning,
  joinParts,
  restoreBackup,
  type RestoreReport,
} from '@cod2admin/backup';
import { migrate as migrateAdmin, SecretBox } from '@cod2admin/admin-store';
import { migrate as migrateBan } from '@cod2admin/ban-store';
import { migrate as migrateWatch } from '@cod2admin/watch-store';
import { USAGE, parseCliArgs, type CliArgs } from './backup/cli-args.js';
import { backupDirFromEnv, createBackupService } from './backup/service.js';
import { getRunningVersion } from './lib/version.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set (run this through cod2admin-backup).`);
  return value;
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'No passphrase: set BACKUP_PASSPHRASE or pass --passphrase-file (stdin is not a terminal).',
    );
  }
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let text = '';
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(text);
          return;
        }
        if (char === '\u0003') process.exit(130);
        if (char === '\u007f') text = text.slice(0, -1);
        else text += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function getPassphrase(args: CliArgs, confirm: boolean): Promise<string> {
  if (args.passphraseFile) {
    return (await readFile(args.passphraseFile, 'utf8')).replace(/\r?\n$/, '');
  }
  if (process.env.BACKUP_PASSPHRASE) return process.env.BACKUP_PASSPHRASE;
  const first = await promptHidden('Backup passphrase: ');
  if (confirm && (await promptHidden('Repeat the passphrase: ')) !== first) {
    throw new Error('The passphrases differ.');
  }
  return first;
}

async function askYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} (type "yes"): `)).trim() === 'yes';
  } finally {
    rl.close();
  }
}

function printReport(report: RestoreReport): void {
  console.log(
    `Backup from ${report.created} (cod2admin ${report.app}); groups: ${report.groups.join(', ')}`,
  );
  console.log(
    `${'table'.padEnd(26)}${'in file'.padStart(10)}${'now'.padStart(10)}`,
  );
  for (const table of report.tables) {
    console.log(
      `${table.name.padEnd(26)}${String(table.fileRows).padStart(10)}${String(table.currentRows).padStart(10)}`,
    );
  }
  for (const warning of report.warnings) console.log(`warning: ${warning}`);
}

/** `file.c2bak.001` stands for all its siblings. */
async function resolveParts(files: readonly string[]): Promise<string[]> {
  if (files.length > 1) return [...files];
  const [file] = files;
  const match = /^(.*)\.001$/.exec(file);
  if (!match) return [file];
  const base = basename(match[1]);
  const siblings = (await readdir(dirname(file)))
    .filter((name) => name.startsWith(`${base}.`) && /\.\d{3}$/.test(name))
    .sort();
  return siblings.map((name) => join(dirname(file), name));
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  if (
    !['export', 'inspect', 'import'].includes(args.command) ||
    !args.files.length
  ) {
    console.log(USAGE);
    return args.command ? 1 : 0;
  }
  const databaseUrl = requireEnv('DATABASE_URL');
  const secretsKey = requireEnv('SECRETS_ENCRYPTION_KEY');
  const service = createBackupService({
    databaseUrl,
    secretsKey,
    appVersion: getRunningVersion(),
    dir: backupDirFromEnv(process.env),
  });
  try {
    // The tables must exist before anything is read or written; a fresh install has none yet.
    await migrateAdmin(databaseUrl);
    await migrateBan(databaseUrl);
    await migrateWatch(databaseUrl);

    if (args.command === 'export') {
      const passphrase = await getPassphrase(args, true);
      const result = await exportBackupToFile(
        {
          pool: service.pool,
          groups: args.groups ?? DEFAULT_GROUPS,
          passphrase,
          secrets: new SecretBox(secretsKey),
          appVersion: getRunningVersion(),
        },
        args.files[0],
      );
      console.log(`Wrote ${args.files[0]} (${result.bytes} bytes).`);
      for (const [name, count] of Object.entries(result.counts)) {
        console.log(`  ${name.padEnd(26)}${count}`);
      }
      return 0;
    }

    const parts = await resolveParts(args.files);
    const passphrase = await getPassphrase(args, false);
    const secrets = new SecretBox(secretsKey);
    const dry = await restoreBackup({
      pool: service.pool,
      source: joinParts(parts),
      passphrase,
      secrets,
      groups: args.groups,
      dryRun: true,
    });
    printReport(dry);
    if (args.command === 'inspect') return 0;

    if (!args.force && (await isGatewayRunning(service.pool))) {
      console.error(
        'A cod2admin gateway is running against this database. Stop it first (or pass --force-running).',
      );
      return 1;
    }
    if (
      !args.yes &&
      !(await askYes('Replace the data above with this backup?'))
    ) {
      console.log('Nothing changed.');
      return 1;
    }
    const empty = await service.pool.query(
      `SELECT (SELECT count(*) FROM admins) + (SELECT count(*) FROM servers) AS n`,
    );
    if (!args.noSnapshot && Number(empty.rows[0].n) > 0) {
      const snapshot = await service.createFile({
        groups: [...DEFAULT_GROUPS, 'watch'],
        passphrase,
        prefix: 'pre-import',
      });
      console.log(`Saved the current data to ${snapshot.path} first.`);
    }
    const done = await restoreBackup({
      pool: service.pool,
      source: joinParts(parts),
      passphrase,
      secrets,
      groups: args.groups,
    });
    console.log(
      `Restored ${done.tables.reduce((n, t) => n + t.fileRows, 0)} rows. Start the bot.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof BackupCryptoError || error instanceof BackupError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    await service.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
