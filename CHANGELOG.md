## 0.0.2 (2026-09-06)

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