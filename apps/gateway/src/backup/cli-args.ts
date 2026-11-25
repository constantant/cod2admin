import {
  BACKUP_GROUPS,
  DEFAULT_GROUPS,
  isBackupGroup,
  type BackupGroup,
} from '@cod2admin/backup';

export interface CliArgs {
  command: string;
  files: string[];
  groups?: BackupGroup[];
  yes: boolean;
  force: boolean;
  noSnapshot: boolean;
  passphraseFile?: string;
}

export function parseGroups(text: string): BackupGroup[] {
  const groups = text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const bad = groups.filter((group) => !isBackupGroup(group));
  if (bad.length || !groups.length) {
    throw new Error(
      `Unknown group ${bad.join(', ') || '(none)'}. Groups: ${BACKUP_GROUPS.join(', ')}.`,
    );
  }
  return groups as BackupGroup[];
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    command: argv[0] ?? '',
    files: [],
    yes: false,
    force: false,
    noSnapshot: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--force-running') args.force = true;
    else if (arg === '--no-snapshot') args.noSnapshot = true;
    else if (arg === '--with-watch') {
      args.groups = [...(args.groups ?? DEFAULT_GROUPS), 'watch'];
    } else if (arg === '--groups') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--groups needs a value.');
      args.groups = parseGroups(value);
    } else if (arg === '--passphrase-file') {
      const value = argv[++i];
      if (value === undefined)
        throw new Error('--passphrase-file needs a path.');
      args.passphraseFile = value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.`);
    else args.files.push(arg);
  }
  return args;
}

export const USAGE = `cod2admin-backup <command> [options]

  export <file>            Write an encrypted backup of the database.
  inspect <file>           Check a backup and show what it holds. Changes nothing.
  import <file>...         Replace the database contents with a backup.
                           Several paths are read as parts (file.c2bak.001, .002, ...).

Options
  --groups core,bans,history,functions,watch   Which groups (default: all but watch).
  --with-watch             Add the watch group to the default groups.
  --yes                    Do not ask for confirmation before an import.
  --force-running          Import even though a gateway seems to be running.
  --no-snapshot            Do not save the current data before an import.
  --passphrase-file <f>    Read the passphrase from a file (or set BACKUP_PASSPHRASE).
`;
