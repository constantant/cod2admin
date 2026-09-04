# CoD2 Admin — Telegram RCON Bot with Report Automation

Status: draft plan · Owner: kk · Last updated: 2026-09-04

## 1. Goal

A Telegram bot that acts as the primary admin interface for one or more Call of Duty 2
dedicated servers:

- Full RCON-backed moderation: kick / ban / unban / tempban, map control, server status.
- **In-game report automation**: a player types `report <name>` (or `!report <name> <reason>`)
  in game chat, and admins on Telegram instantly get a card with everything they need to
  act — no need to alt-tab into the server console.
- Multi-admin system with roles, managed entirely from Telegram (no config-file editing to
  add/remove an admin).
- Designed to run inside the existing Nx workspace as a small set of apps/libs.

## 2. Prior art review

### 2.1 [tinyrcon](https://github.com/atib80/tinyrcon) (atib80)

- C++ (Win32 API + ASIO + nlohmann json), desktop GUI, Windows-only today.
- Two tiers: **public** TinyRcon server/client (shared rcon password) and **private**
  TinyRcon server/client (per-admin username+password, separate port).
- All connected clients talk to a central **TinyRcon server**, which is the thing that
  actually holds the game server's rcon password and talks UDP RCON to CoD1/2/4/5. Clients
  never see the raw rcon password.
- The server keeps a synchronized ban store (temp bans, IP bans, IP-range bans, city bans,
  country bans, name bans, "protected player" allowlist) and pushes updates to every
  connected client so all admins see the same ban list live.
- Config is a `tinyrcon.json` per app (server IP/port, rcon password, listen ports, etc).
- **Takeaway for us**: the "central gateway process holds the rcon secret, clients are thin
  and per-admin authenticated" pattern is exactly right for a Telegram bot too — the bot
  process is effectively a headless TinyRcon-server-equivalent, and each Telegram admin is a
  "client" identified by Telegram user ID instead of a username/password.

### 2.2 ReCodMod / RCM Admintool ([mdVisitor fork](https://github.com/mdVisitor/ReCodMod-RCM-Admintool))

- PHP, supports COD1/COD1:UO/COD2/COD4[+CoD4X]/COD5. 65+ in-game **chat commands**
  (`!kick`, `!banall`, `!rules`, `!getss`, `!login`, etc.) — i.e. admins can moderate from
  inside the game too, not just from an external tool.
- Has a **`!report` / `!support` command today** — but it emails the admin (gmail/yahoo/
  yandex SMTP), not Telegram. This is the closest existing feature to what we want; we're
  essentially swapping the transport from email to Telegram and adding rich context +
  one-tap actions.
- Other notable features worth stealing: ban reasons + temp bans, IP ban list, banlist/
  unbanlist chat commands, GeoIP-based welcome messages, anonymous-proxy/VPN auto-kick, bad
  nickname auto-kicker, `!getss` (forces a screenshot of a suspected cheater via anticheat/
  CoD4X hooks), stats/message rotation.

### 2.3 [Membrane](https://github.com/Aidoneus/Membrane) (Vangers monitoring bot)

- Different game (Vangers), but directly validates the shape of our project: a Node.js
  service that monitors game servers and pushes notifications into Telegram. Confirms
  Telegram-as-admin-console is a proven pattern, just not one anyone has wired up for CoD2
  specifically.

### 2.4 Protocol / server facts that constrain the design

- CoD1/2/4 RCON is the Quake3-derived **out-of-band UDP** protocol: packets prefixed with
  `0xFFFFFFFF`, payload `rcon <password> <command>`. CoD2's RCON is **not** challenge-based
  (unlike later CoD4X hardening), so the rcon password travels in cleartext per-packet and
  the protocol is a known UDP amplification/spoofing target — the gateway must rate-limit
  and the server should be firewalled to only accept RCON from the gateway's IP.
- `banUser`/`banClient` write the player's **GUID** to `ban.txt`. There is a known bug:
  when the (defunct) GameSpy/PB master server can't be reached, players can connect with
  **GUID 0**, which cannot be banned by GUID — `banClient` silently no-ops and
  `tempBanClient` only kicks. Our ban flow must detect GUID `0`/empty and fall back to an
  **IP-based ban** (kick + add IP to a firewall/deny list or a `ban.txt` IP-based workaround)
  rather than silently failing.
- Game events (connect/disconnect/chat/kills) are written to
  `$fs_homepath/main/games_mp.log`. This is the standard integration point for detecting the
  `report <name>` chat trigger when running vanilla CoD2.
- **CoD2x** (unofficial community patch) adds a UDP rate limiter (DDoS mitigation — good, we
  should recommend it regardless) and GSC-level `http_fetch` / `websocket_connect` /
  `websocket_sendText` script functions, which could in principle push events out of the game
  process instead of us tailing a log file. Since the gateway and game server are confirmed
  same-host (§6), that would only ever be a `127.0.0.1`-bound call, and its only edge over
  log-tailing is dodging log-format quirks (color codes, encoding) — not latency or
  reachability. **Decision: not worth the added GSC-mod surface for that alone; log-tailing
  is the sole report-intake path (§5, §9).**

### 2.5 Conclusion

No existing open-source tool does "CoD2 RCON + Telegram + automated in-game report intake"
end-to-end. The closest is RCM's email-based `!report`. We're building a new tool, but every
sub-piece (rcon client, ban sync, log tailing, chat-triggered report) has prior art to crib
from.

## 3. Architecture

```
┌────────────────────┐   games_mp.log tail   ┌──────────────────────────┐
│  CoD2 Dedicated      │ ───────────────────▶ │                          │
│  Server (1..N)       │                      │   Admin Gateway service   │
│  (RCON UDP, localhost) │ ◀─────────────────── │   (Node.js/TS, Nx app)   │
└────────────────────┘   RCON UDP commands   │                          │
     (same host)                             │  ┌────────────────────┐  │
                                              │  │ rcon-client lib     │  │
                                              │  │ log-tailer lib      │  │
                                              │  │ report-pipeline lib │  │
                                              │  │ ban-store (DB)      │  │
                                              │  │ admin-store (DB)    │  │
                                              │  └────────────────────┘  │
                                              │           │              │
                                              │   Telegram Bot API       │
                                              └───────────┼──────────────┘
                                                          ▼
                                              Telegram group/channel
                                              (admin chat, inline buttons)
```

### 3.1 Components (proposed Nx layout under `packages/`)

- `packages/rcon-client` — lib. Pure TS implementation of the Quake3/CoD OOB UDP RCON
  protocol (`getstatus`, `getinfo`, `rcon <pw> <cmd>`). No game-specific knowledge beyond
  parsing `status`/`players` output. Includes the rate-limiter/backoff for outgoing packets.
- `packages/log-tailer` — lib. Follows `games_mp.log` on the local filesystem (same-host
  deployment, see §6), parses connect/disconnect/say/kill lines into typed events. Sole
  report-intake path — no GSC/push adapter.
- `packages/report-pipeline` — lib. Owns the `report <name>` chat-trigger logic: fuzzy-
  matches the reported name against the live player list (pulled via `rcon-client` status),
  assembles the report card (see §5), applies per-reporter cooldown/anti-spam.
- `packages/ban-store` + `packages/admin-store` — lib. Persistence (see §7): bans, tempban
  expiries, admin roles, audit log. Thin repository layer over SQLite/Postgres.
- `apps/gateway` — the long-running service: owns the RCON connections to every configured
  game server, runs the log tailer(s), runs the report pipeline, exposes an internal command
  bus.
- `apps/telegram-bot` — Telegram webhook/long-poll handler, command router, inline-keyboard
  callback handler. Talks to `apps/gateway` in-process (simplest: one process, two entry
  concerns) or via an internal queue if we want them separately deployable later. **Recommend
  starting as a single deployable app** (`apps/gateway` hosts both the Telegram bot and the
  RCON/log logic) — split later only if a real scaling reason shows up.

### 3.2 Tech stack recommendation

- **Language/runtime**: TypeScript on Node.js — matches the existing Nx/TS workspace
  (`tsconfig.base.json`, `@nx/js`), and both required protocols (UDP dgram sockets, Telegram
  HTTP API) are well supported in Node's stdlib + small deps.
- **Telegram library**: [grammy](https://grammy.dev) (modern, TS-first, good middleware
  model for inline keyboards and role-gated commands) — preferred over
  `node-telegram-bot-api`, which is effectively unmaintained.
- **RCON transport**: hand-rolled over Node's `dgram` module — the protocol is ~30 lines,
  not worth a dependency (and no well-maintained CoD-specific one exists).
- **DB** *(decided)*: **Postgres**, via **Drizzle ORM** (TS-first, good migration story).
  Since the gateway already runs on the game server host (§6), Postgres can run alongside it
  (local instance or a small managed instance) — no need to default to SQLite first.

## 4. Admin & role management (all via Telegram, no config-file edits)

Roles, stored in `admin-store`:

- **Owner** — bootstrapped once via an env var (`OWNER_TELEGRAM_ID`) or a one-time setup
  command from the first person to `/claim` with a secret printed in the gateway's startup
  logs. Can add/remove admins of any role, manage per-server access, view full audit log.
- **Admin** — kick/ban/unban/tempban, map/server control, sees report cards, can act on them.
- **Moderator** — kick/tempban/mute only (no permanent ban, no server/map control) — useful
  for trusted community members who triage reports without full authority.
- Commands (owner/admin only, enforced by a grammy middleware checking `admin-store`):
  - `/addadmin <reply-or-@user> <role>`
  - `/removeadmin <@user>`
  - `/listadmins`
  - `/setrole <@user> <role>`
- Every privileged action (kick/ban/unban/role change) is written to an **audit log** table
  (who, what, target, reason, timestamp, source = telegram button / telegram command / auto)
  and a `/auditlog [n]` command lets an owner review recent actions.
- Multi-server support: admins can be scoped to specific servers (`admin_servers` join
  table); `/servers` lists configured servers, most commands take an optional
  `--server <alias>` (default = the group chat's bound server, one Telegram group per
  server, configured via `/bindserver <alias>` in that group).

## 5. In-game report automation (the core feature)

1. **Trigger detection**: player sends `report PlayerName` or `!report PlayerName reason...`
   in game chat. `log-tailer` watches `games_mp.log` (local file, same host), matches the
   `say`/`sayteam` line pattern, and extracts reporter + raw text into an internal
   `ReportEvent`.
2. **Resolve target**: pull live `status` via `rcon-client`, fuzzy-match `PlayerName`
   against connected players (handles partial names, color-code-stripped comparison,
   case-insensitivity). If ambiguous, the report card lists candidates for the admin to pick.
3. **Enrich**: for the resolved player, gather everything available without extra rcon
   round-trips beyond `status`:
   - Client ID, current GUID (flag if `0`/masterserver-unavailable), IP address, ping,
     score, current session duration (tracked by `log-tailer` since their `connect` line).
   - Prior history from `ban-store`/`admin-store` audit log: previous reports against this
     name/GUID/IP, previous kicks/bans/warnings, first-seen date if we've logged them
     before.
   - Reporter's own info (name/GUID) for accountability and to apply the anti-spam cooldown.
   - Last N chat lines from this player (small ring buffer kept by `log-tailer` per active
     session) — useful context for admins without needing to watch console live.
4. **Anti-spam**: per-reporter cooldown (e.g. one report per 60s, configurable) and simple
   duplicate-suppression (same reporter+target within a window collapses into one updated
   card rather than spamming the chat) — otherwise a small flood of `report` spam becomes a
   Telegram-flood vector.
5. **Deliver to Telegram**: message posted to the server's bound admin group, with:
   - Header: `🚨 Report: <reporter> reported <target>` + reason if given.
   - Body: the enrichment data from step 3, formatted compactly.
   - Inline keyboard: `Kick` · `Temp Ban (30m)` · `Ban` · `Ignore` · `More info ▾` (expands
     with full status dump / chat history).
6. **Action execution**: button press → grammy callback handler → permission check → RCON
   command via `rcon-client` → on success, edit the Telegram message to show the resolved
   state (who acted, what action, timestamp) and write the audit log row. **Decided**: every
   kick/ban/tempban also fires an `rcon say "<target> was <action> by an admin"` broadcast
   into the game for transparency (§6) — not silent, not optional per-action (a per-server
   opt-out toggle can be added later if a community wants it, but the default is on).
7. **GUID-0 fallback**: if the target's GUID is `0`/blank, the `Ban` button executes an
   IP-based ban (add to a `ban_ips` table enforced by the gateway itself — e.g. gateway
   periodically diffs `status` against `ban_ips` and auto-kicks matches — since the game
   binary can't ban by IP natively) and the card clearly labels this as "IP ban (GUID
   unavailable)".

## 6. Server status & management

- `/status [server]` — condensed `status` output (map, player count/max, uptime) as a
  Telegram message, auto-refreshable via an inline "Refresh" button.
- `/players [server]` — live player list with per-player inline `Kick`/`Ban` shortcuts (same
  action path as the report card, just triggered manually).
- `/map <name>`, `/maprotate`, `/restart`, `/fastrestart` — map control, admin-role-gated.
- `/say <message>` — broadcast to the game via `rcon say`.
- **Moderation broadcasts** *(decided)*: every kick/ban/tempban (whether triggered via a
  report card or a manual `/kick`/`/ban` command) also sends an `rcon say` announcement to
  the game, so players see moderation happening rather than a name silently vanishing — see
  §5 step 6.
- `/rcon <raw command>` — owner-only raw passthrough escape hatch, always logged to the audit
  log verbatim (necessary power-user backdoor, but must be tightly scoped and logged given
  it bypasses all higher-level guardrails).
- **Connectivity model** *(decided)*: the gateway runs on the same host as the CoD2 server,
  and the target server(s) run **CoD2x**. This means:
  - `log-tailer` reads `games_mp.log` straight off the local filesystem — no SSH/SFTP agent
    needed, and it's the sole report-intake path (no GSC push adapter — see §2.4).
  - RCON calls hit `127.0.0.1`/localhost, so packet spoofing from off-box attackers is a
    non-issue for the gateway↔server leg (still keep the RCON port firewalled from the
    public internet regardless — no reason to expose it).
  - CoD2x is still worth running for its built-in UDP rate limiter (§8), independent of the
    report-intake decision.

## 7. Data model (sketch)

- `admins(telegram_id, role, added_by, added_at)`
- `admin_servers(telegram_id, server_alias)`
- `servers(alias, rcon_host, rcon_port, rcon_password_encrypted, log_source_config,
  bound_telegram_chat_id)`
- `bans(id, server_alias, guid, ip, name, reason, banned_by, banned_at, expires_at,
  is_ip_fallback)`
- `reports(id, server_alias, reporter_name, reporter_guid, target_name, target_guid,
  target_ip, reason, raw_chat_line, created_at, resolved_action, resolved_by, resolved_at)`
- `audit_log(id, actor_telegram_id, action, target, server_alias, detail_json, created_at)`

`rcon_password` and any other secrets stored **encrypted at rest** (e.g. libsodium secretbox
with a key from env), not plaintext in the DB — the gateway is the only thing that ever needs
the decrypted value. Postgres runs on the same host (§3.2); back it up with routine
`pg_dump` snapshots since it now holds the durable ban/audit history, not just cache-able
state.

## 8. Security notes

- RCON UDP is spoofable/floodable (see §2.4) — firewall each game server's RCON port to only
  accept from the gateway's egress IP where the hosting provider allows it; recommend CoD2x's
  built-in rate limiter regardless.
- Telegram side: every mutating command/button goes through a role-check middleware; deny by
  default for unknown Telegram user IDs.
- Rate-limit outgoing RCON commands from the gateway itself (a burst of Telegram button
  clicks or a report flood shouldn't hammer the game server).
- Validate/sanitize anything interpolated into an RCON command (player-supplied report
  reasons, chat text) before it could ever be echoed via `rcon say` — avoid command/argument
  injection into the RCON stream.

## 9. Phased delivery plan

- **Phase 0 — foundations**: `rcon-client` lib with `status`/`kick`/`banClient`/`banUser`/
  `unban`/`say`/`map`, unit-tested against a mock UDP peer. Single hardcoded server via env
  vars, no DB yet.
- **Phase 1 — Telegram MVP**: `apps/gateway` wraps Phase 0 lib; grammy bot exposes
  `/status`, `/players`, `/kick`, `/ban`, `/unban`, `/map`. Owner-only, single admin (env
  var), no roles yet.
- **Phase 2 — admin & data layer**: `admin-store`/`ban-store` on Postgres via Drizzle;
  `/addadmin`/`/removeadmin`/`/setrole`, audit log, multi-server support (`servers` table,
  per-group binding).
- **Phase 3 — report automation**: `log-tailer` + `report-pipeline`; `report <name>` chat
  trigger → enriched Telegram card → inline-button actions → anti-spam cooldown → GUID-0
  IP-fallback ban path.
- **Phase 4 — nice-to-haves** (borrow from RCM): GeoIP-enriched player info on report cards,
  proxy/VPN auto-kick list, bad-nickname auto-kicker, `!getss`-style screenshot capture if an
  anticheat hook is available, periodic stats digest posted to the Telegram group.

## 10. Open questions for the user

- ~~Hosting topology~~ — **resolved**: gateway runs on the same host as the CoD2 server(s).
- ~~CoD2x acceptable?~~ — **resolved**: yes, target server(s) run CoD2x — used for its UDP
  rate limiter (§8); the HTTP/WS push adapter idea was considered and **dropped** (§2.4) since
  same-host removes its only advantage over log-tailing.
- ~~SQLite vs Postgres~~ — **resolved**: Postgres from the start (§3.2, §7).
- ~~In-game ban feedback~~ — **resolved**: every kick/ban/tempban broadcasts via `rcon say`
  (§5 step 6, §6), not silent.

All open questions are resolved — plan is ready to move into Phase 0 implementation whenever
you want to start.

## Sources

- https://github.com/atib80/tinyrcon
- https://github.com/mdVisitor/ReCodMod-RCM-Admintool
- https://github.com/Aidoneus/Membrane
- https://github.com/callofduty2x/CoD2x
- https://github.com/bgauduch/call-of-duty-2-docker-server/blob/main/doc/readme.md
- https://wiki.zeroy.com/index.php/Call_of_Duty:_Rcon_Commands
