## [1.0.1](https://github.com/constantant/cod2admin/releases/tag/v1.0.1) (2026-09-07)

### 🚀 Features

- **gateway:** boot-time confirmation for successful self-updates ([1a7dd02](https://github.com/constantant/cod2admin/commit/1a7dd02))

### 🩹 Fixes

- **installer:** clean up the checksum file after a successful update ([6dc46e2](https://github.com/constantant/cod2admin/commit/6dc46e2))
- **release:** match major-version changelog headings in release.sh ([039d18d](https://github.com/constantant/cod2admin/commit/039d18d))

### ❤️ Thank You

- Claude Sonnet 5
- kk

# [1.0.0](https://github.com/constantant/cod2admin/releases/tag/v1.0.0) (2026-09-07)

### 🚀 Features

- **gateway:** add /bans command, fix /unban to match its own guid-or-ip signature ([95405eb](https://github.com/constantant/cod2admin/commit/95405eb))
- **gateway:** self-update poller and /update command ([ee21b54](https://github.com/constantant/cod2admin/commit/ee21b54))
- **installer:** versioned release layout + apply-update.sh for self-updates ([cf2ce8c](https://github.com/constantant/cod2admin/commit/cf2ce8c))

### ❤️ Thank You

- Claude Sonnet 5
- kk

## [0.0.4](https://github.com/constantant/cod2admin/releases/tag/v0.0.4) (2026-09-06)

### 🩹 Fixes

- **installer:** actually respawn the OpenRC service on crash ([18e8d4c](https://github.com/constantant/cod2admin/commit/18e8d4c))

### ❤️ Thank You

- Claude Sonnet 5
- kk

## [0.0.3](https://github.com/constantant/cod2admin/releases/tag/v0.0.3) (2026-09-06)

### 🩹 Fixes

- **release:** publish one install-ready archive instead of the bare gateway bundle ([c68a39e](https://github.com/constantant/cod2admin/commit/c68a39e))
- **release:** link changelog headings to their GitHub release, fix regex escaping bug ([b77b6ad](https://github.com/constantant/cod2admin/commit/b77b6ad))
- **release:** keep version specifiers out of the changelog command ([cf9b695](https://github.com/constantant/cod2admin/commit/cf9b695))

### ❤️ Thank You

- Claude Sonnet 5
- kk

## [0.0.2](https://github.com/constantant/cod2admin/releases/tag/v0.0.2) (2026-09-06)

### 🚀 Features

- **data-layer:** add admin-store and ban-store packages (Postgres via Drizzle)
- **gateway:** scaffold Phase 1 Telegram gateway app
- **gateway:** add roles, multi-server, audit log, tempban, rcon, say
- **gateway:** implement report-card action execution and GUID-0 ban fallback
- **gateway:** wire GameLogTailer per server into main.ts
- **gateway:** add bilingual /help and /help_ru commands
- **installer:** add pure host installer for real CoD2 server admins
- **log-tailer:** implement !report chat trigger detection
- **log-tailer:** live file tailing and session bookkeeping
- **phase3:** scaffold log-tailer and report-pipeline packages
- **report-pipeline:** implement !report target resolution
- **report-pipeline:** implement !report target enrichment
- **report-pipeline:** implement !report anti-spam cooldown and dedup
- **report-pipeline:** implement report card composition and delivery orchestration

### 🩹 Fixes

- **dev-env:** repair CoD2 dev server docker setup, confirm GUID-0 behavior
- **dev-env:** split fs_homepath into its own bind mount so games_mp.log is tailable
- **log-tailer:** match real games_mp.log lines with leading control bytes
- **rcon-client:** status column-drift and kick name/quoting quirks
- **rcon-client:** correct signed 16-bit port wraparound in status parser
- **release:** skip nx's lockfile update, do it via corepack pnpm instead

### ❤️ Thank You

- Claude Sonnet 5
- kk