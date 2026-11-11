## [1.23.0](https://github.com/constantant/cod2admin/releases/tag/v1.23.0) (2026-11-11)

### 🚀 Features

- add a spectator bot that scores aim and is controlled from the Mini App ([0f81563](https://github.com/constantant/cod2admin/commit/0f81563))

### ❤️ Thank You

- Konstantin

## [1.22.0](https://github.com/constantant/cod2admin/releases/tag/v1.22.0) (2026-11-10)

### 🚀 Features

- map previews in the Mini App (Maps, Dashboard, Players) ([5490bb3](https://github.com/constantant/cod2admin/commit/5490bb3))
- add loading-screen previews for 146 multiplayer maps ([5496966](https://github.com/constantant/cod2admin/commit/5496966))
- add the cod2admin logo ([2ae897d](https://github.com/constantant/cod2admin/commit/2ae897d))
- show the release notes properly on the Mini App's Update page ([693acae](https://github.com/constantant/cod2admin/commit/693acae))
- show the current map as a banner on the Dashboard and Players page ([3d4bbfa](https://github.com/constantant/cod2admin/commit/3d4bbfa))
- show the game mode on the Players page banner ([2350ff0](https://github.com/constantant/cod2admin/commit/2350ff0))

### ❤️ Thank You

- Claude Sonnet 5.5
- kk

## [1.21.0](https://github.com/constantant/cod2admin/releases/tag/v1.21.0) (2026-11-09)

### 🚀 Features

- add known players — nicknames tied to provider networks ([dab8465](https://github.com/constantant/cod2admin/commit/dab8465))
- add a Known players page to the Mini App ([f863bcd](https://github.com/constantant/cod2admin/commit/f863bcd))
- mark a player as known from their Mini App sheet ([cb602bd](https://github.com/constantant/cod2admin/commit/cb602bd))
- slim down the Mini App player sheet with a More menu ([88dbddc](https://github.com/constantant/cod2admin/commit/88dbddc))
- tie GUIDs to known players ([32f6774](https://github.com/constantant/cod2admin/commit/32f6774))
- show the Mini App player actions as icon buttons with tooltips ([63b1be5](https://github.com/constantant/cod2admin/commit/63b1be5))
- kick a known name that shows up with a different GUID ([19238c9](https://github.com/constantant/cod2admin/commit/19238c9))

### 🩹 Fixes

- always offer "mark as known" in the Mini App player sheet ([709143e](https://github.com/constantant/cod2admin/commit/709143e))
- ask for the ASN/GUID inline in the Mini App player sheet ([7f38edb](https://github.com/constantant/cod2admin/commit/7f38edb))

### ❤️ Thank You

- Claude Sonnet 5.5
- kk

## [1.20.0](https://github.com/constantant/cod2admin/releases/tag/v1.20.0) (2026-11-08)

### 🚀 Features

- let admins edit the bot's game-chat lines ([4966491](https://github.com/constantant/cod2admin/commit/4966491))

### ❤️ Thank You

- kk

## [1.19.1](https://github.com/constantant/cod2admin/releases/tag/v1.19.1) (2026-11-07)

### 🩹 Fixes

- read AI client metadata from hosts that refuse this server ([63f7f76](https://github.com/constantant/cod2admin/commit/63f7f76))

### ❤️ Thank You

- kk

## [1.19.0](https://github.com/constantant/cod2admin/releases/tag/v1.19.0) (2026-11-07)

### 🚀 Features

- let each staff member connect their own AI ([79b4c48](https://github.com/constantant/cod2admin/commit/79b4c48))

### ❤️ Thank You

- kk

## [1.18.0](https://github.com/constantant/cod2admin/releases/tag/v1.18.0) (2026-11-06)

### 🚀 Features

- replace admin roles with permissions ([2deaad8](https://github.com/constantant/cod2admin/commit/2deaad8))

### ❤️ Thank You

- kk

## [1.17.1](https://github.com/constantant/cod2admin/releases/tag/v1.17.1) (2026-11-06)

### 🩹 Fixes

- **rcon-client:** drop players with clientkick so IP bans remove them ([0299c74](https://github.com/constantant/cod2admin/commit/0299c74))

### ❤️ Thank You

- kk

## [1.17.0](https://github.com/constantant/cod2admin/releases/tag/v1.17.0) (2026-11-05)

### 🚀 Features

- **ban-store:** keep and show player names on IP bans ([#8](https://github.com/constantant/cod2admin/issues/8))
- **ban-store:** fill in names on existing IP bans and show them in /bans ([275d407](https://github.com/constantant/cod2admin/commit/275d407))
- **gateway:** add chat mutes the bot enforces from the log ([#7](https://github.com/constantant/cod2admin/issues/7))

### 🩹 Fixes

- **gateway:** don't punish muted players for quick messages ([71a79cd](https://github.com/constantant/cod2admin/commit/71a79cd))
- **miniapp-web:** show full player names in the chat recipient list ([#9](https://github.com/constantant/cod2admin/issues/9))
- **miniapp-web:** stop clipping the server and role dropdowns ([bbd6052](https://github.com/constantant/cod2admin/commit/bbd6052))

### ❤️ Thank You

- Claude Opus 5.5
- kk

## [1.16.1](https://github.com/constantant/cod2admin/releases/tag/v1.16.1) (2026-11-04)

### 🩹 Fixes

- **installer:** make updates finish under systemd and keep the encryption key ([dcbaaaf](https://github.com/constantant/cod2admin/commit/dcbaaaf))

### ❤️ Thank You

- Claude Opus 5.5
- kk

## [1.16.0](https://github.com/constantant/cod2admin/releases/tag/v1.16.0) (2026-11-03)

### 🚀 Features

- **miniapp-web:** add dashboard, report queue, notes and chat-command parity ([a460d48](https://github.com/constantant/cod2admin/commit/a460d48))
- **miniapp-web:** add a Russian interface ([f115fc9](https://github.com/constantant/cod2admin/commit/f115fc9))

### 🩹 Fixes

- **gateway:** stop admins changing the owner with /removeadmin and /setrole ([c208c17](https://github.com/constantant/cod2admin/commit/c208c17))
- **gateway:** work out what a silent level command did ([eec6481](https://github.com/constantant/cod2admin/commit/eec6481))

### ❤️ Thank You

- Claude Opus 5.5
- kk

## [1.15.3](https://github.com/constantant/cod2admin/releases/tag/v1.15.3) (2026-11-03)

### 🩹 Fixes

- **gateway:** make /update report every outcome, also over a relay ([0f1aa2b](https://github.com/constantant/cod2admin/commit/0f1aa2b))

### ❤️ Thank You

- Claude Opus 5.5
- kk

## [1.15.2](https://github.com/constantant/cod2admin/releases/tag/v1.15.2) (2026-11-03)

### 🩹 Fixes

- **gateway:** make /findlog check the reported log path before searching ([4b2b346](https://github.com/constantant/cod2admin/commit/4b2b346))

### ❤️ Thank You

- Claude Opus 5.5
- kk

## [1.15.1](https://github.com/constantant/cod2admin/releases/tag/v1.15.1) (2026-11-03)

### 🩹 Fixes

- **gateway:** tell the owner how to give the bot access to the game log ([7a99218](https://github.com/constantant/cod2admin/commit/7a99218))

### ❤️ Thank You

- Claude Opus 5.5
- kk

## [1.15.0](https://github.com/constantant/cod2admin/releases/tag/v1.15.0) (2026-11-03)

### 🚀 Features

- **gateway:** add /findlog to find and connect a server's game log ([39cd895](https://github.com/constantant/cod2admin/commit/39cd895))
- **installer:** add a Docker kit for hosts the installer can't run on ([e053d98](https://github.com/constantant/cod2admin/commit/e053d98))

### ❤️ Thank You

- Claude Opus 5.5
- Claude Opus 5.5 (1M context)
- kk

## [1.14.0](https://github.com/constantant/cod2admin/releases/tag/v1.14.0) (2026-10-07)

### 🚀 Features

- switch the game mode together with the map ([5d7a8ba](https://github.com/constantant/cod2admin/commit/5d7a8ba))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.13.1](https://github.com/constantant/cod2admin/releases/tag/v1.13.1) (2026-10-07)

### 🩹 Fixes

- **rcon-client:** send map once instead of retrying it ([fa56975](https://github.com/constantant/cod2admin/commit/fa56975))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.13.0](https://github.com/constantant/cod2admin/releases/tag/v1.13.0) (2026-10-07)

### 🚀 Features

- **admin-store:** add a miniapp audit source ([244843c](https://github.com/constantant/cod2admin/commit/244843c))
- **ban-store:** search, read and edit bans ([e090d96](https://github.com/constantant/cod2admin/commit/e090d96))
- **gateway:** serve the Telegram Mini App API alongside the bot ([a3120da](https://github.com/constantant/cod2admin/commit/a3120da))
- **installer:** set up HTTPS for the Mini App with Caddy ([1cc5bbe](https://github.com/constantant/cod2admin/commit/1cc5bbe))
- **log-tailer:** read recent chat from the end of the game log ([3712bd6](https://github.com/constantant/cod2admin/commit/3712bd6))
- **miniapp-web:** add the Telegram Mini App server manager ([ec9d255](https://github.com/constantant/cod2admin/commit/ec9d255))
- **rcon-client:** add tell() for private messages to one player ([27578ee](https://github.com/constantant/cod2admin/commit/27578ee))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.12.0](https://github.com/constantant/cod2admin/releases/tag/v1.12.0) (2026-10-07)

### 🚀 Features

- **gateway:** show every installed map in /maps and check /map names ([c967d00](https://github.com/constantant/cod2admin/commit/c967d00))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.11.0](https://github.com/constantant/cod2admin/releases/tag/v1.11.0) (2026-10-07)

### 🚀 Features

- **gateway:** optionally kick VPN players on sight with /vpnkick ([d4e7016](https://github.com/constantant/cod2admin/commit/d4e7016))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.10.0](https://github.com/constantant/cod2admin/releases/tag/v1.10.0) (2026-10-07)

### 🚀 Features

- **gateway:** short role-based /help with the full guide attached ([417ece2](https://github.com/constantant/cod2admin/commit/417ece2))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.9.1](https://github.com/constantant/cod2admin/releases/tag/v1.9.1) (2026-10-07)

### 🩹 Fixes

- **gateway:** make /help and /help_ru send again ([6d2e88d](https://github.com/constantant/cod2admin/commit/6d2e88d))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.9.0](https://github.com/constantant/cod2admin/releases/tag/v1.9.0) (2026-10-07)

### 🚀 Features

- **gateway:** send long lists as a short summary with an attached .md report ([0a7a036](https://github.com/constantant/cod2admin/commit/0a7a036))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.8.0](https://github.com/constantant/cod2admin/releases/tag/v1.8.0) (2026-10-07)

### 🚀 Features

- **gateway:** let admins mark provider networks as VPN with /vpnnets ([8fb13bb](https://github.com/constantant/cod2admin/commit/8fb13bb))
- **gateway:** optionally show the player's city in /players, /bans and report cards ([#2](https://github.com/constantant/cod2admin/issues/2))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.7.0](https://github.com/constantant/cod2admin/releases/tag/v1.7.0) (2026-10-07)

### 🚀 Features

- **gateway:** flag VPN, proxy and Tor IPs in /players and report cards ([8ec994e](https://github.com/constantant/cod2admin/commit/8ec994e))
- **gateway:** show the IP's provider in /players and report cards ([3e14334](https://github.com/constantant/cod2admin/commit/3e14334))

### 🩹 Fixes

- **release:** keep apostrophes out of the single-quoted notes script ([431fcbd](https://github.com/constantant/cod2admin/commit/431fcbd))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.6.1](https://github.com/constantant/cod2admin/releases/tag/v1.6.1) (2026-10-07)

### 🩹 Fixes

- **gateway:** make GUID bans and unbans actually reach ban.txt ([1e4e0d4](https://github.com/constantant/cod2admin/commit/1e4e0d4))
- **gateway:** only switch Telegram routes when the route is really down ([e15a2ee](https://github.com/constantant/cod2admin/commit/e15a2ee))
- **release:** publish each release's full changelog section as its notes ([9628684](https://github.com/constantant/cod2admin/commit/9628684))

### ❤️ Thank You

- Claude Opus 5.5
- Claude Opus 5.5 (1M context)
- kk

## [1.6.0](https://github.com/constantant/cod2admin/releases/tag/v1.6.0) (2026-10-04)

### 🚀 Features

- **gateway:** show admins' Telegram names instead of IDs ([#1](https://github.com/constantant/cod2admin/issues/1))

### ❤️ Thank You

- Claude Opus 5.5
- kk

## [1.5.0](https://github.com/constantant/cod2admin/releases/tag/v1.5.0) (2026-10-04)

### 🚀 Features

- **gateway:** reach Telegram through free relays where it's blocked ([8766fb1](https://github.com/constantant/cod2admin/commit/8766fb1))

### ❤️ Thank You

- Claude Opus 5.5
- kk

## [1.4.0](https://github.com/constantant/cod2admin/releases/tag/v1.4.0) (2026-10-04)

### 🚀 Features

- **gateway:** show the country of player IPs ([372b166](https://github.com/constantant/cod2admin/commit/372b166))

### 🩹 Fixes

- **rcon-client:** parse status rows whose name overflows its column ([ff40788](https://github.com/constantant/cod2admin/commit/ff40788))

### ❤️ Thank You

- Claude Opus 5.5
- kk

## [1.3.0](https://github.com/constantant/cod2admin/releases/tag/v1.3.0) (2026-10-04)

### 🚀 Features

- **ban-store:** make bans apply on every server ([835980a](https://github.com/constantant/cod2admin/commit/835980a))

### ❤️ Thank You

- Claude Opus 5.5
- kk

## [1.2.1](https://github.com/constantant/cod2admin/releases/tag/v1.2.1) (2026-10-04)

### 🩹 Fixes

- **rcon-client:** quote say text so Cyrillic isn't dropped ([ddf1d94](https://github.com/constantant/cod2admin/commit/ddf1d94))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.2.0](https://github.com/constantant/cod2admin/releases/tag/v1.2.0) (2026-10-04)

### 🚀 Features

- **gateway:** add /addserver, /removeserver and /setdefault ([bd8594e](https://github.com/constantant/cod2admin/commit/bd8594e))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.1.2](https://github.com/constantant/cod2admin/releases/tag/v1.1.2) (2026-10-03)

### 🩹 Fixes

- **rcon-client:** send and read Russian text as CP1251 ([7822df3](https://github.com/constantant/cod2admin/commit/7822df3))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.1.1](https://github.com/constantant/cod2admin/releases/tag/v1.1.1) (2026-10-03)

### 🩹 Fixes

- **rcon-client:** survive rate-limited servers and read multi-packet replies ([f0f6817](https://github.com/constantant/cod2admin/commit/f0f6817))

### ❤️ Thank You

- Claude Opus 5.5 (1M context)
- kk

## [1.1.0](https://github.com/constantant/cod2admin/releases/tag/v1.1.0) (2026-09-08)

### 🚀 Features

- **gateway:** add /maps command for tap-to-switch map selection ([f330bad](https://github.com/constantant/cod2admin/commit/f330bad))

### ❤️ Thank You

- Claude Sonnet 5
- kk

## [1.0.3](https://github.com/constantant/cod2admin/releases/tag/v1.0.3) (2026-09-07)

### 🩹 Fixes

- **admin-store:** persist logSourceConfig when re-upserting a server ([2b62475](https://github.com/constantant/cod2admin/commit/2b62475))

### ❤️ Thank You

- Claude Sonnet 5
- kk

## [1.0.2](https://github.com/constantant/cod2admin/releases/tag/v1.0.2) (2026-09-07)

### 🚀 Features

- **installer:** add crash recovery to the no-systemd/no-OpenRC fallback ([b71c7c5](https://github.com/constantant/cod2admin/commit/b71c7c5))

### 🩹 Fixes

- **report-pipeline:** add missing unbannedAt to test fixtures ([eb52a76](https://github.com/constantant/cod2admin/commit/eb52a76))

### ❤️ Thank You

- Claude Sonnet 5
- kk

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