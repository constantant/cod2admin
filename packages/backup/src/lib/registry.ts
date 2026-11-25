/**
 * Which tables a backup covers (docs/PLAN-backup.md §2). Names are the Postgres table names, so
 * the backup needs no import of the three Drizzle schemas. `registry.spec.ts` compares this list
 * with the tables that exist after migrations, so a new table cannot silently miss the backup.
 */
export const BACKUP_GROUPS = [
  'core',
  'bans',
  'history',
  'functions',
  'watch',
] as const;

export type BackupGroup = (typeof BACKUP_GROUPS)[number];

export const GROUP_TABLES: Record<BackupGroup, readonly string[]> = {
  core: [
    'admins',
    'admin_permissions',
    'admin_servers',
    'telegram_users',
    'servers',
    'settings',
  ],
  bans: ['bans', 'ban_ips', 'mutes'],
  history: [
    'audit_log',
    'reports',
    'player_notes',
    'server_snapshots',
    'known_players',
  ],
  functions: ['custom_functions'],
  watch: [
    'watch_profiles',
    'watch_profile_names',
    'watch_lives',
    'watch_population_days',
    'watch_evidence',
  ],
};

/** On unless the owner switches it off. `watch` is large and rebuilds itself. */
export const DEFAULT_GROUPS: readonly BackupGroup[] = [
  'core',
  'bans',
  'history',
  'functions',
];

/**
 * Tables that are deliberately not in any group: live OAuth sessions (they re-authorize) and
 * Drizzle's bookkeeping. Restoring `admins` clears the `mcp_*` tables through their foreign keys.
 */
export const EXCLUDED_TABLES: readonly string[] = [
  'mcp_pending',
  'mcp_codes',
  'mcp_grants',
  'mcp_retired_refresh',
  'mcp_access',
  'admin_store_migrations',
  'ban_store_migrations',
  'watch_store_migrations',
];

/** Columns holding a `SecretBox` value. Inside the backup they are plaintext (the file is encrypted). */
export const SECRET_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  servers: ['rcon_password_encrypted', 'watch_private_password_encrypted'],
};

/**
 * Rows that belong to this host, not to the data: never exported and never deleted by an import.
 * The backup passphrase is encrypted with this host's key, so it would be useless anywhere else.
 */
export const HOST_ROWS: Readonly<Record<string, string>> = {
  settings: `key IN ('backup.passphrase')`,
};

export function isBackupGroup(value: string): value is BackupGroup {
  return (BACKUP_GROUPS as readonly string[]).includes(value);
}

export function groupOfTable(table: string): BackupGroup | undefined {
  return BACKUP_GROUPS.find((group) => GROUP_TABLES[group].includes(table));
}

export function tablesOfGroups(groups: readonly BackupGroup[]): string[] {
  return groups.flatMap((group) => [...GROUP_TABLES[group]]);
}
