# Backup export / import — plan

Status: **B1–B4 built 2026-11-25** (library, CLI and installer step, Mini App page, schedule to Telegram); B5 is open. Not tried on a real server or in a real browser yet. See §11 for where the build differs from this plan. Companion to `docs/PLAN.md` §7 (which only says
"run routine `pg_dump`", with nothing shipped to do it).
Russian summary: `docs/PLAN-backup-ru.md` (keep in sync).

## 1. Goal

The owner can export the bot's data to one file and import it later to restore the bot after a
lost host, a broken database, a move to another server, or a bad change. Today bans, admins,
servers (with RCON passwords), audit history, notes, known players, custom functions and watch data
live only in Postgres on the same host as the bot.

### Decisions (proposed, 2026-11-25)

- **App-level export, not only `pg_dump`.** A logical file made by the gateway works for all three
  DB modes (local Postgres from the installer, external `DATABASE_URL`, dev docker) with no
  `pg_dump` binary or version match, can be checked before it is applied, and survives schema
  changes between versions. `pg_dump` stays a documented extra (B5), not the feature.
- **A CLI is required, the Mini App is not enough.** Restoring onto a fresh install means there is
  no owner row yet, so nobody can log into the Mini App. The CLI runs on the host with `.env`.
  The Mini App gets export and import for a running install (B3).
- **Secrets are re-encrypted with a passphrase** (§4). The file never holds a value that only the
  old host's `SECRETS_ENCRYPTION_KEY` can open.
- **Replace, not merge,** in v1. Import wipes the chosen groups and loads the file in one
  transaction. A merge mode (union of bans) is a later phase.
- **Scheduled backup to Telegram (added 2026-11-25).** The bot sends the encrypted backup file as a
  document to the owner's private chat on a schedule (§6.1). Because a Telegram chat is cloud
  storage, any file sent there is encrypted **as a whole**, not only its secrets (§4).
- **Owner only.** New permission `backup.manage`, owner-sticky like `OWNER_GRANTED_PERMISSIONS`,
  not in `MCP_PERMISSIONS`. Export hands over every RCON password.

## 2. What goes in the file

Tables come from three Drizzle schemas, each with its own migrations table
(`admin_store_migrations`, `ban_store_migrations`, `watch_store_migrations`).

| Group       | Tables                                                                                            | Default                                        |
| ----------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `core`      | `admins`, `admin_permissions`, `admin_servers`, `telegram_users`, `servers`, `settings`           | on, always                                     |
| `bans`      | `bans`, `ban_ips`, `mutes`                                                                        | on                                             |
| `history`   | `audit_log`, `reports`, `player_notes`, `server_snapshots`, `known_players`                       | on                                             |
| `functions` | `custom_functions`                                                                                | on                                             |
| `watch`     | `watch_profiles`, `watch_profile_names`, `watch_lives`, `watch_population_days`, `watch_evidence` | **off** (large, ages out on a 14/90 day clock) |

**Never exported:** `mcp_pending`, `mcp_codes`, `mcp_grants`, `mcp_retired_refresh`, `mcp_access`
(live OAuth sessions, they re-authorize) and the three `*_migrations` tables.

**Guard against drift:** a spec walks every `pgTable` with Drizzle's `getTableConfig` and fails if
a table is in neither the registry nor the explicit exclude list. A new table can't silently miss
the backup.

## 3. File format

One `.c2bak` file = gzip of NDJSON, streamed (the audit log can be big, never build it in memory).

```
{"t":"manifest","format":1,"app":"1.27.0","created":"2026-11-25T..","groups":["core",..],
 "migrations":{"admin":"0012_custom_functions","ban":"0004_mutes","watch":"0000_initial"},
 "secrets":{"kdf":"scrypt","salt":"..","check":".."}}
{"t":"table","name":"servers","columns":["alias","rcon_host",..]}
{"t":"row","v":[...]}            // one per row, values in `columns` order
{"t":"end","counts":{"servers":3,..},"sha256":".."}
```

- Column list is stored per table, so import survives schema changes: a column the file lacks takes
  the DB default (refuse if it is NOT NULL with no default), a column the file has but the DB lacks
  is dropped with a warning.
- Refuse a file whose `format` is newer than the app. Warn when `migrations` are older.
- `bigint` and `timestamptz` are written as strings/ISO so nothing loses precision in JSON.
- `end.sha256` covers everything before it, so a truncated download is caught before any write.

## 4. Secrets

Encrypted columns: `servers.rcon_password_encrypted`, `servers.watch_private_password_encrypted`,
and whatever `log_source_config` holds (check for credentials; treat as secret if it does).

- Export: decrypt with the running `SecretBox`, re-encrypt each value with a key derived from the
  user's **passphrase** (scrypt, per-file salt, AES-256-GCM, reusing `SecretBox`'s format).
  `manifest.secrets.check` is a known string encrypted with that key, so import knows a wrong
  passphrase before it touches the DB.
- Import: decrypt with the passphrase, encrypt with the target host's own `SECRETS_ENCRYPTION_KEY`.
  So moving to a new host with a new key works.
- **Whole-file encryption:** the gzip stream is encrypted in chunks (AES-256-GCM, key from the same
  scrypt derivation, a fresh nonce per 1 MiB chunk with the chunk index authenticated, so
  reordering or truncation fails). The manifest line is inside the encrypted stream. Only a short
  plaintext header (magic, format, salt, KDF cost) stays outside. Audit rows, IPs and notes are
  therefore unreadable to anyone who gets the file, including from a Telegram chat. This applies to
  every export, so there is one format, not two.
- Passphrase is required for export, minimum length enforced. No "no passphrase" option.
- Never logged, never in `audit_log.detail_json`, never in an error message.

## 5. Import

`importBackup(file, passphrase, opts)` in the library, used by CLI and Mini App.

1. **Dry run** (default). Parse, verify checksum and passphrase, compare versions, and return a
   report: counts per table now vs. in the file, warnings (dropped columns, older migrations),
   groups present. No write.
2. **Pre-import snapshot:** export the current DB to `backups/pre-import-<ts>.c2bak` (same
   passphrase) so an import can be undone.
3. **Apply** in one transaction per database: `TRUNCATE ... CASCADE` for the chosen groups, insert
   in FK order (`admins` before `admin_permissions`, `mcp_*` untouched), then `setval` every serial
   and bigserial sequence to `max(id)`. Any error rolls back and leaves the old data.
4. **Reload:** the gateway keeps ban lists, servers, relays, templates and RCON clients in memory.
   After a Mini App import, the gateway restarts itself the way `/update` does. The CLI import
   requires the gateway stopped (refuses if it can still take the advisory lock).
5. One `backup_import` audit row, written after the restore (it goes into the restored table).

Bans enforcement must not run mid-import: the CLI needs the gateway stopped, the Mini App path
pauses the ban poller and rejects other writes until the restart.

## 6. Surfaces

- **Library:** new `packages/backup` (`registry.ts`, `writer.ts`, `reader.ts`, `crypto.ts`,
  `import.ts`). Depends on the three store packages for schemas.
- **CLI:** `cod2admin-backup export|inspect|import` shipped in the installer bundle next to
  `apply-update.sh`; reads `.env`. `inspect` is the dry run and needs no gateway.
- **Mini App:** routes in `apps/gateway/src/miniapp/routes-backup.ts`:
  `POST /backup/export` (passphrase in body, streams the file), `POST /backup/import/preview`
  (upload, returns the §5.1 report and a one-time token), `POST /backup/import/apply` (token +
  typed confirmation). Page "Backup" in the management section, owner only. Upload cap about 256 MB
  with a streamed parse.
- **Telegram:** no import from Telegram (a file and a passphrase don't belong in a chat). Owner-only
  `/backup` shows status and controls the schedule (§6.1), and `/backup now` sends one right away.

### 6.1 Scheduled backup (B4)

A scheduler in the gateway (one timer, like the daily watch prune) runs the export and delivers it.

- **Settings:** `settings` key `backup.schedule` =
  `{ enabled, interval: 'daily' | 'weekly' | 'every N hours', at: 'HH:MM' (server time zone),
groups, telegram: bool, keepLocal: N, lastRun, lastStatus }`. Default off.
  Set from the Mini App Backup page or `/backup schedule daily 04:00`, `/backup off`.
- **Passphrase:** never typed into a Telegram chat. It comes from env `BACKUP_PASSPHRASE` or is set
  on the Mini App page and stored encrypted with `SecretBox` in `settings`. No passphrase: the
  schedule refuses to enable. The owner must remember it, since losing it makes the files useless
  (the page says so).
- **Local copy:** always written to `backups/` first, last `keepLocal` kept (default 7), so a
  Telegram failure loses nothing.
- **Delivery:** `sendDocument` to the owner's private chat (`OWNER_TELEGRAM_ID`, the chat is the
  DM, never a group), file name `cod2admin-<host>-<date>.c2bak`, caption with app version, size,
  row counts and "needs your passphrase". It goes through the existing route failover in
  `apps/gateway/src/lib/telegram-routes.ts`, so it works on hosts in Russia that use the Deno and
  Cloudflare relays. Check the relays' request body limit during B4, since a 50 MB upload through a
  Worker may be cut.
- **Size limit:** the Bot API accepts up to 50 MB. Over the limit (check the encrypted size, not the
  row count): first retry without the optional groups (`history` then `watch`), and if it still
  doesn't fit, split the stream into `.c2bak.001`, `.002` parts under 45 MB each (the reader
  concatenates them). A split file is sent as several messages. If even that is not wanted, a
  setting `telegram: 'notify-only'` sends just a message that the local copy is ready.
- **Failures:** a failed export or send retries twice with backoff, then messages the owner
  "backup failed: <reason>" (no secrets in it) and keeps the local file. `lastStatus` is shown on
  the page. A missed run (gateway was down at `at`) runs at the next start.
- **Not a replacement for off-host:** the Telegram copy is off-host by nature, which is the point,
  and Telegram keeps it only as long as the message stays in the chat. The docs say to also keep one
  copy elsewhere.
- Audit: `backup_scheduled_run` and `backup_scheduled_failed` rows (no file contents).

## 7. Risks

| Risk                                        | Handling                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import wipes live data                      | Dry run first, typed confirmation, automatic pre-import snapshot, single transaction                                                                                 |
| File leaks RCON passwords                   | Passphrase-encrypted secrets, owner-only, no passphrase in logs; the rest (audit, IPs) is sensitive too, so the docs say to store the file like a password           |
| New table forgotten                         | Registry drift spec (§2)                                                                                                                                             |
| Schema moves on between export and import   | Per-table column lists (§3), format version, migration warnings                                                                                                      |
| Sequences left behind after import          | `setval` per sequence, covered by a test that inserts after import                                                                                                   |
| Memory blowup on a big audit log            | NDJSON streaming both ways, batched inserts (1000 rows)                                                                                                              |
| Stale in-memory state after Mini App import | Restart as in `/update`; ban poller paused during the run                                                                                                            |
| Import into a mid-migration DB              | Run `migrate()` first, then import                                                                                                                                   |
| Backup sits in a Telegram chat for years    | Whole-file encryption (§4); Telegram staff and anyone with the owner's account only get ciphertext. A weak passphrase is the weak point, so enforce a minimum length |
| Passphrase lost                             | Warn on the page; files are unrecoverable, by design                                                                                                                 |
| Upload above 50 MB or relay body limit      | Drop optional groups, then split into parts, then notify-only (§6.1)                                                                                                 |
| Schedule silently stops                     | `lastStatus` on the page, owner message on failure, missed run catches up on start                                                                                   |
| Owner changed `OWNER_TELEGRAM_ID`           | Sent to the current owner only; schedule re-reads it each run                                                                                                        |

## 8. Tests

- Round trip on real Postgres (dev docker): seed, export, wipe, import, export again, compare rows.
- Wrong passphrase, truncated file, bad checksum and newer format are refused with no write.
- Older-file fixture (a column missing, a column extra) imports with the warnings.
- Failure halfway through leaves the old data (force an FK error).
- Sequences continue after import. `servers_one_default_idx` and `admins_one_owner_idx` hold.
- A passphrase never shows up in logs or audit (grep the captured output).
- Moving to a different `SECRETS_ENCRYPTION_KEY` yields a server whose RCON password still decrypts.
- Registry drift spec.
- Whole-file encryption: flipped byte, dropped or reordered chunk and wrong passphrase all fail with
  no write. The file contains no plaintext row (grep for a known IP and name).
- Scheduler with a fake clock: fires at `at`, catches up after a missed run, retries then reports,
  keeps only `keepLocal` files, refuses to enable with no passphrase.
- Telegram send with a mocked sender: goes to the owner DM only, uses the route failover, over-limit
  file falls back to dropping groups, then splitting, and the parts reassemble to a file that imports.
- No passphrase or file content in the Telegram caption, error message or audit row.

## 9. Phases

1. **B1 — Library:** registry, writer, reader, crypto, import transaction, drift spec, round-trip tests.
2. **B2 — CLI and installer:** `cod2admin-backup`, bundled by `scripts/build-installer-bundle.sh`,
   a "restore from backup" step in `installer/install.sh` that asks for a file and passphrase after
   migrations, before the bot starts (this is the real disaster-recovery path).
3. **B3 — Mini App:** routes, Backup page, `backup.manage` permission, audit rows, restart.
4. **B4 — Scheduled backups to Telegram** (§6.1): scheduler, `backup.schedule` setting, local
   retention, owner DM delivery with size fallback and splitting, `/backup` command, failure
   messages, pre-import snapshots listed in the page. Depends on the whole-file encryption from B1.
5. **B5 — Docs and extras:** `pg_dump` recipe for external DBs, merge mode for bans, update
   `PLAN.md` §7, `PLAN-miniapp.md` §0 and the Russian summaries.

## 10. Open questions

- Keep `audit_log` in the default export? It is large and holds IPs, but restoring it keeps the
  history. Proposed: yes, with a checkbox to drop it.
- The scheduled job needs the passphrase on the host (env or encrypted in `settings`), next to
  `SECRETS_ENCRYPTION_KEY`. Fine, since the point of the Telegram copy is surviving a lost host, and
  the file stays encrypted away from it. Confirm.
- Schedule choices: is daily at a fixed time enough, or do you want "every N hours" too?
- Should a file over 50 MB be split into parts, or is dropping `history` and notifying enough?
- Should the watch data (§2, off by default) be restorable at all, given it rebuilds itself?

## 11. As built (2026-11-25)

Where the code differs from the plan above, or settled a point the plan left open:

- **One database, one transaction.** The three stores share one `DATABASE_URL`, so the import is a
  single transaction, not one per store. Tables, columns, foreign keys and sequences are read from
  Postgres at run time (`packages/backup/src/lib/db.ts`) instead of from the Drizzle schemas; the
  registry (`registry.ts`) only names the tables, and `registry.spec.ts` checks it against the
  migrated database.
- **Secrets are plaintext inside the encrypted stream.** Because the whole file is encrypted (§4),
  there is no separate `manifest.secrets.check` and no second layer: export decrypts the
  `servers` secrets with the host key, import encrypts them with the target host's key. A wrong
  passphrase shows up as a failed first block.
- **Format:** `.c2bak` = 27-byte header (magic, scrypt salt and cost, nonce prefix), then 1 MiB
  AES-256-GCM blocks (`packages/backup/src/lib/crypto.ts`). The NDJSON stream has a manifest with
  every table and its columns up front, rows as `{"t":"r","n":table,"v":[...]}`, and an `end`
  line with counts. There is no `sha256`: block authentication plus the last-block flag detect
  damage and cut-off files.
- **Host-only rows.** `settings.backup.passphrase` (encrypted with this host's key) is never
  exported, and an import leaves it in place (`HOST_ROWS`).
- **Restoring `core` empties `mcp_*`** through the foreign keys, as planned. An import refuses to
  run if the cascade would reach any other table that is not in the file.
- **Running gateway check.** A gateway holds a shared Postgres advisory lock for its whole life
  (`presence.ts`); `cod2admin-backup import` asks for the exclusive one and refuses when it
  cannot get it (`--force-running` overrides).
- **Restart after a Mini App restore** is `process.exit(1)` 1.5 s after the answer, so systemd
  (`Restart=on-failure`) and OpenRC's `supervise-daemon` start the bot again. With no supervisor
  (the installer's "none" fallback) the bot stays down and has to be started by hand.
- **Schedule modes:** `daily` at `HH:MM` and `every N hours` (1–720). State is in `settings`
  (`backup.schedule`, with a `since` stamp; `backup.lastRun`). A slot missed while the bot was down
  runs once at the next minute tick.
- **Telegram delivery:** `sendDocument` to the owner's DM through the bot's route failover.
  Over 45 MB: a copy without `watch`, then without `history`, is sent (the full file stays on the
  host); if that is still over, it is split into `.001`, `.002` parts. Two retries (30 s, 2 min),
  then a "Backup failed" message with no secrets.
- **File names** in the backup folder: `cod2admin-` (scheduled), `manual-` (Backup page),
  `pre-import-` (saved before every restore) and `send-` (temporary). Only `cod2admin-` files are
  pruned by `keepLocal`. The folder is `BACKUP_DIR`, else `backups/` beside the update staging
  folder; the installer creates it and writes `BACKUP_DIR` to `.env`.
- **Not built:** restoring split parts from the Mini App (upload one whole file; the CLI joins
  `.001` parts), merge mode and the `pg_dump` recipe (B5), and an existing install gets the
  `cod2admin-backup` wrapper only after the installer is run again (an update does not add it).
  Also not done: the web page has not been opened in a browser, and nothing was run against a
  real server.

### Using it

```
cod2admin-backup export /root/cod2admin.c2bak          # asks for a passphrase twice
cod2admin-backup inspect /root/cod2admin.c2bak         # what is in it, nothing changed
cod2admin-backup import  /root/cod2admin.c2bak         # stop the bot first; asks you to type yes
cod2admin-backup import  part.c2bak.001                # joins .001, .002 ... next to it
```

`BACKUP_PASSPHRASE` or `--passphrase-file` replace the prompt. `install.sh` asks for a backup
file after writing the config and restores it before the first start (`BACKUP_FILE` and
`BACKUP_PASSPHRASE` in the config file for a non-interactive install).
