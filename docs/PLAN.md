# CoD2 Admin — Telegram RCON Bot with Report Automation

Status: draft plan · Owner: kk · Last updated: 2026-09-07

## 1. Goal

A Telegram bot that acts as the primary admin interface for one or more Call of Duty 2
dedicated servers:

- Full RCON-backed moderation: kick / ban / unban / tempban, map control, server status.
- **In-game report automation**: a player types `!report <name> <reason>` in game chat, and
  admins on Telegram instantly get a card with everything they need to act — no need to
  alt-tab into the server console.
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
  - Separately: `tempBanClient`'s own ban *duration* is controlled by a server-wide cvar
    rather than a per-call argument, and (unverified, but consistent with how this family of
    Q3-derived RCON servers behaves) the block is likely in-memory and doesn't survive a
    map/server restart. Neither property is compatible with an admin picking an arbitrary
    duration from a Telegram button. **Decision: our temp-ban flow never calls
    `tempBanClient` at all** — see §5.6.
  - **Confirmed (was: verify before Phase 3):** tested 2026-09-05 against the actual dev server
    (§11.1, real CoD2 1.4.6.8 client connecting over LAN) — the connecting player got GUID `0`
    (`Connecting player #0 has a zero GUID` in the server log). Since a modern, unmodified client
    hit this on the very first connection attempt, GUID 0 should be treated as **the default
    case, not a rare fallback** — GUID can't be the primary correlation key for ban/report history
    (§5.3, §7); history lookups must key off IP+name whenever GUID is `0`, since every GUID-0
    player would otherwise collide into one shared identity. Design for this as the common path
    when Phase 3 (§9) is built, not as an edge case.
  - **Correction (2026-09-06):** the same real-server testing found `rcon status`'s player table
    *can* include a `guid` column directly (this dev server's — a "cracked"/ibuddieat-patched
    build — does, value `0`, matching the confirmed finding above) — contradicting the
    Phase-2-planning-time research conclusion that GUID is only obtainable by tailing
    `games_mp.log`. That conclusion still holds as the *general*/portable answer (no other
    source documents a `guid` column, and `rcon-client`'s parser has to treat it as
    optional/absent on servers that don't have it), but Phase 3 should re-check `status()` for a
    `guid` column on the actual target server before assuming log-tailing is the only source.
  - **Re-confirmed (2026-09-06, live query against the running dev server, not just re-reading
    the note above):** `RconClient#status()` returns the `guid` column today (`status-parser.ts`
    already parses it generically), value `0` for the connected test player — same result as the
    2026-09-05 finding, now checked directly rather than inferred. **Phase 3 implication:**
    `report-pipeline`'s enrichment step (§5.3) can read GUID straight off the `status()` call it
    already makes for target resolution (§5 step 2) on this target server — it does not need
    `log-tailer` to extract GUID from `games_mp.log` connect lines. `log-tailer`'s scope stays
    limited to `!report` trigger detection and in-memory session bookkeeping (§5 step 3). A
    server without a `guid` column in `status` would still need log-tailing for it, per the
    general/portable caveat above — just not this one.
  - **Quirks found empirically (2026-09-05/06), now handled in `rcon-client`:** (a) this
    server's `status` table has a column-width mismatch starting right after `name` — every
    server build should be assumed capable of this, not just this one, since it stems from the
    game engine's own formatting, not our parser (fixed: `status-parser.ts` now derives
    everything after `name` from the line's actual remaining text rather than trusting the
    header/separator's byte offsets literally); (b) `kick` only accepts a player's **name**, not
    the numeric slot `status` reports — passing a slot number gets a silent-looking
    "Player N is not on the server" reply; (c) that same `kick` needs the name **unquoted** for
    plain ASCII names but **quoted** for names containing non-ASCII bytes (e.g. Cyrillic) —
    the opposite quoting fails each case differently. `RconClient#kick` now resolves numeric
    input by looking up the name via `status()` first, and automatically retries with quotes if
    the first attempt's response looks like either failure shape, rather than guessing from the
    name's content.
  - **Bug found during the 2026-09-06 GUID re-check, fixed same day:** `status()`'s parsed
    `port` field went negative for high port numbers (e.g. a real `address` of
    `172.18.0.1:52931` came back as `ip: "172.18.0.1", port: -12605` — `65536 - 12605 = 52931`).
    Root cause: the game engine itself prints the unsigned 16-bit UDP port through a signed
    16-bit formatter, so anything above `32767` prints as a negative decimal in the raw `status`
    text — not a parsing mistake on our side, a quirk of the server's own output. Fixed in
    `status-parser.ts` (`unwrapSignedPort`): negative parsed ports are corrected back via
    `port + 65536`. Never blocked Phase 3 (the GUID-0 IP-fallback ban path, §5 step 7/§7
    `ban_ips`, matches on `ip` only, never `port`), but `StatusPlayer.port` is now correct for
    any future use.
- Game events (connect/disconnect/chat/kills) are written to
  `$fs_homepath/main/games_mp.log`. This is the standard integration point for detecting the
  `!report <name>` chat trigger when running vanilla CoD2.
  - **Confirmed format (2026-09-06, real dedicated server, `packages/log-tailer/test/fixtures/`):**
    chat lines are `<minutes>:<seconds> (say|sayteam);<guid>;<num>;<name>;<message>` — e.g.
    `115:19 say;0;0;WOWOWOW;HEU!`. `<guid>` is field 1, matching the `status()` GUID-0 finding
    above (the same real session's chat lines all showed `guid=0`). `<name>` was observed
    **empty** on a player's first couple of chat lines right after connecting, before their name
    had propagated into the log stream — `log-tailer` callers must not assume `name` is
    populated. Connect/quit lines follow the same `guid;num;name` shape (`J;...`/`Q;...`); kill/
    death lines (`K;`/`D;`) carry attacker and victim blocks back to back — parsed by
    `log-tailer`'s `chat-parser.ts` so far, connect/quit/kill parsing not yet implemented.
  - **Dev-environment gap found 2026-09-06, fixed same day:** §11.1 previously documented
    `games_mp.log` as landing at `docker/cod2server/main/games_mp.log` on the host via a bind
    mount, but that was stale on two counts, discovered while capturing the fixture above: (a)
    `docker-compose.yml`'s `cod2_server` volume for `fs_basepath` (game data) was since changed
    to a **named volume** (`cod2admin-dev-cod2-main:/home/cod2/main`, working around an
    upstream bind-mount bug, #94) — nothing under `/home/cod2/main` reaches the host filesystem
    anymore; and (b) `games_mp.log` itself, under the image's *default* `fs_homepath`
    (`~/.callofduty2`), is a symlink to `/dev/stdout` (confirmed via `docker exec ... ls -la`) —
    routed into `docker logs` rather than written as a real file, so even a correct bind mount at
    the old path wouldn't have made it tailable. The fixture above was captured via `docker
    logs`, not a filesystem tail. **Fixed** by giving `fs_homepath` its own separate bind mount,
    distinct from `fs_basepath`'s named volume: `docker-compose.yml` now passes
    `+set fs_homepath /home/cod2/homedir` at launch (a `set`/`seta` inside an `+exec`'d config is
    too late — `fs_homepath` is a "protected" cvar per `server_mp.cfg`'s own comment) and mounts
    `./docker/cod2server/homedir:/home/cod2/homedir`. Verified: `games_mp.log` now lands as a
    real, growing text file at `docker/cod2server/homedir/main/games_mp.log` on the host
    (`COD2_LOG_PATH` in `.env`/`.env.example`, updated), containing only game-event lines
    (`InitGame`/`J`/`Q`/`K`/`D`/`say`/`sayteam`/...) — console noise (heartbeats, hitch warnings,
    `Rcon from ...`) stays in the separate `console_mp_server.log` next to it, cleanly split for
    the first time. See `docker/cod2server/README.md`'s "Known issue" section for the two-volume
    rationale. Real production (§6, same-host, not necessarily this Docker image) may never have
    had either issue — unconfirmed, and moot now that dev matches the intended filesystem-tail
    model either way.
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

                                              ↻ (not shown above: the gateway also self-polls
                                                 `status` on a fixed interval — bans/ban_ips
                                                 expiry enforcement only, see §5.7)
```

The gateway has three ways it starts doing something: an inbound log-tail event (chat/connect/
disconnect), an inbound Telegram command/button, and — the one non-event-driven path — a
fixed-interval self-poll of `status` used only to enforce IP bans against GUID-0 players (§5.7).

### 3.1 Components (proposed Nx layout under `packages/`)

- `packages/rcon-client` — lib. Pure TS implementation of the Quake3/CoD OOB UDP RCON
  protocol (`getstatus`, `getinfo`, `rcon <pw> <cmd>`). No game-specific knowledge beyond
  parsing `status`/`players` output. Includes the rate-limiter/backoff for outgoing packets.
- `packages/log-tailer` — lib. Follows `games_mp.log` on the local filesystem (same-host
  deployment, see §6), parses connect/disconnect/say/kill lines into typed events. Sole
  report-intake path — no GSC/push adapter.
- `packages/report-pipeline` — lib. Owns the `!report <name>` chat-trigger logic: fuzzy-
  matches the reported name against the live player list (pulled via `rcon-client` status),
  assembles the report card (see §5), applies per-reporter cooldown/anti-spam.
- `packages/ban-store` + `packages/admin-store` — lib. Persistence (see §7): bans, tempban
  expiries, admin roles, audit log. Thin repository layer over SQLite/Postgres.
- `apps/gateway` — the single long-running service for now: owns the RCON connections to
  every configured game server, runs the log tailer(s), runs the report pipeline, and hosts
  the Telegram bot (grammy long-polling — see §3.2) as an internal module (command router +
  inline-keyboard callback handler calling straight into the in-process gateway logic, no
  queue). Split the Telegram side into its own `apps/telegram-bot` deployable later only if a
  real scaling reason shows up — not planned up front.

### 3.2 Tech stack recommendation

- **Language/runtime**: TypeScript on Node.js — matches the existing Nx/TS workspace
  (`tsconfig.base.json`, `@nx/js`), and both required protocols (UDP dgram sockets, Telegram
  HTTP API) are well supported in Node's stdlib + small deps.
- **Telegram library**: [grammy](https://grammy.dev) (modern, TS-first, good middleware
  model for inline keyboards and role-gated commands) — preferred over
  `node-telegram-bot-api`, which is effectively unmaintained.
- **Telegram transport** *(decided)*: **long-polling**, not webhooks. The gateway runs on the
  game server host (§6), which has no reason to expose a public HTTPS endpoint/cert — long
  polling needs only outbound HTTPS to Telegram's API, which is simpler to firewall correctly
  than standing up an inbound webhook receiver on a box whose main job is hosting a game
  server.
- **RCON transport**: hand-rolled over Node's `dgram` module — the protocol is ~30 lines,
  not worth a dependency (and no well-maintained CoD-specific one exists).
- **DB** *(decided)*: **Postgres**, via **Drizzle ORM** (TS-first, good migration story).
  Since the gateway already runs on the game server host (§6), Postgres can run alongside it
  (local instance or a small managed instance) — no need to default to SQLite first.

## 4. Admin & role management (all via Telegram, no config-file edits)

Roles, stored in `admin-store`:

- **Owner** — bootstrapped once, via **either** an env var (`OWNER_TELEGRAM_ID`, checked and
  inserted into `admin-store` on first startup) **or** a one-time `/claim <secret>` command
  matching a secret printed in the gateway's startup logs — whichever happens first wins.
  `/claim` is a no-op (and gets an explicit "owner already set" reply) the moment any row with
  role `Owner` exists in `admin-store` — it is not a standing command, so a second person
  can't claim ownership later. Enforced via a DB-level unique constraint/transaction on
  `role = 'Owner'`, not just an application-level check-then-insert, so two people racing
  `/claim` at the same instant can't both succeed. Owners can add/remove admins of any role,
  manage per-server access, and view the full audit log.
- **Admin** — kick/ban/unban/tempban, map/server control, sees report cards, can act on them.
- **Moderator** — kick/tempban only (no permanent ban, no server/map control) — useful for
  trusted community members who triage reports without full authority. (Chat **mute** was
  considered but dropped from v1: vanilla CoD2 RCON has no native per-player mute, and faking
  one server-side would need a GSC chat hook — see the Phase 4 note in §9 if this becomes a
  priority.)
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
  server, configured via `/bindserver <alias>` in that group). **Scoping is access-only, not
  per-server role** — `admins.role` is one global value per Telegram ID, so an admin can be
  granted or denied a given server, but can't be e.g. Moderator on one server and Admin on
  another. Acceptable for now (single-operator/small-team use case); revisit if multi-tenant
  usage with different trust levels per server actually comes up.

## 5. In-game report automation (the core feature)

1. **Trigger detection**: player sends `!report PlayerName reason...` in game chat —
   **`!report` prefix required**, no bare `report` trigger. A bare-word trigger would fire on
   ordinary chat containing the word "report" (e.g. "report card", "reporting in"); requiring
   the `!` prefix matches the convention RCM's chat commands already use (§2.2) and avoids
   false positives. `log-tailer` watches `games_mp.log` (local file, same host), matches the
   `say`/`sayteam` line pattern, and extracts reporter + raw text into an internal
   `ReportEvent`.
2. **Resolve target**: pull live `status` via `rcon-client`, fuzzy-match `PlayerName`
   against connected players (handles partial names, color-code-stripped comparison,
   case-insensitivity). If ambiguous, the card posts with **no** `Kick`/`Temp Ban`/`Ban`
   buttons yet — instead one row of `Select: <candidate 1>` / `Select: <candidate 2>` / ...
   buttons (plus `Ignore`), built from the same `status` pull with no extra rcon round trip.
   Picking one edits the message in place into the normal resolved card (step 5) for that
   specific player; `Ignore` here dismisses the whole report without acting on anyone.
   If the named player has already disconnected by the time `status` comes back (race between
   the chat line and the rcon round-trip), post the card anyway using the last-known info
   `log-tailer` cached for that session (§5.3), clearly labeled "target disconnected" with no
   action buttons except `Ignore` — kick/ban buttons are pointless against a player who isn't
   connected, and `Ban` would still need a resolvable GUID/IP, which is exactly what's now
   stale.

   **Implemented (2026-09-06)**, `packages/report-pipeline`: `resolveReportTarget()` takes the
   `!report` target name plus a `{ rcon, sessions }` dependency pair (narrow interfaces —
   `status()` / `listSessions()` — not the concrete `RconClient`/`GameLogTailer` classes, so
   tests inject fakes per §11.2) and returns one of `resolved` / `ambiguous` / `disconnected` /
   `not-found`. Matching (`matchPlayersByName`, shared between the live-`status()` lookup and the
   session-cache fallback) is an exact case-insensitive match if one exists, else case-insensitive
   substring containment — no color-code stripping needed here, since `status()` already returns
   color-stripped names (`rcon-client`'s `status-parser.ts`) and log-tailer's chat-derived names
   never had codes to begin with. `not-found` (matching nothing live *or* cached) isn't named in
   this plan section but is a real reachable state (typo'd/already-fully-expired name) — treated
   like the disconnected case's "nothing to act on," left for the Telegram-card layer to word
   appropriately. When more than one cached session matches (two different slots having carried
   the same name at different times — possible since sessions are never deleted, only marked
   disconnected, §5 step 3), picks whichever was active most recently rather than an arbitrary one.
3. **Enrich**: for the resolved player, gather everything available without extra rcon
   round-trips beyond `status`:
   - Client ID, current GUID (flag if `0`/masterserver-unavailable), IP address, ping,
     score, current session duration (tracked by `log-tailer` since their `connect` line).
   - Prior history from `ban-store`/`admin-store` audit log: previous reports against this
     name/GUID/IP, previous kicks/bans/warnings, first-seen date if we've logged them
     before. **When the current GUID is `0`** (see §2.4 caveat), skip GUID in the
     correlation key entirely and match on IP+name only — otherwise every GUID-0 player
     would incorrectly share one "identity" in the history lookup.
   - Reporter's own info (name/GUID) for accountability and to apply the anti-spam cooldown.
   - Last N chat lines from this player (small ring buffer kept by `log-tailer` per active
     session) — useful context for admins without needing to watch console live.

   **Restart caveat**: session duration, the chat ring buffer, and the "last-known info" used
   for the disconnected-target fallback (step 2) are all in-memory state built up from
   `connect` lines as `log-tailer` follows the log live — none of it is persisted. A gateway
   restart mid-match loses that context for every currently-connected player until they
   reconnect (a fresh `connect` line re-seeds it); it does not affect `ban-store`/`admin-store`
   history, which is on Postgres. Accepted for now as an MVP limitation — revisit (e.g. replay
   recent log lines on startup to rebuild session state) if restarts during active play turn
   out to be frequent enough to matter.

   **Implemented (2026-09-06)**, `packages/log-tailer`:
   - `FileTailer` follows `games_mp.log` by **polling** `fs.stat`/re-reading new bytes on a
     timer (default 1s), not `fs.watch`/`fs.watchFile` — in dev this file is written by a
     process inside a Docker container into a host bind mount (§11.1), and change-notification
     delivery across that boundary isn't reliable; a poll works the same way regardless of what's
     writing the file. It starts reading from the file's *current* end (matching the restart
     caveat above — nothing is replayed), buffers a trailing partial line across polls, and
     restarts from byte 0 if the file shrinks (covers log rotation/truncation, not currently
     expected from this game server but cheap to handle).
   - `SessionTracker` is pure in-memory logic (no file I/O, independent of `FileTailer`, its own
     unit tests) keyed by client **slot number** (`num`), not GUID — GUID is `0` for multiple
     concurrent players (§2.4), so it can't identify one specific connection. A session's
     duration is measured against **wall-clock `Date.now()`**, captured when its `connect` line
     is processed — deliberately not the log's own in-game `mm:ss` field, which resets to `0:00`
     on every map change and so can't measure a session spanning a map rotation. A session is
     never deleted on disconnect, only marked (`disconnectedAt` set, duration frozen) and kept
     until that slot's next `connect` overwrites it — this *is* the "last-known info" step 2
     needs for its disconnected-target fallback, not a separate cache.
   - `GameLogTailer` composes both into the `!report`-detection + session-state entry point
     report-pipeline will consume (`chat`/`reportTrigger`/`connect`/`disconnect` events,
     `getSession`/`listSessions`). Verified against the real dev container's `games_mp.log`
     (post-§2.4-fix), not just temp-file tests.

   **Implemented (2026-09-06)**, `packages/report-pipeline`'s `enrichReport()`: assembles
   everything above from data already in hand — no new rcon/DB round-trips beyond the ones
   listed. Live fields (IP/ping/score) come from `resolveReportTarget`'s `status()` result;
   session duration/chat history from log-tailer's `getSession(num)` (undefined/`[]` if
   log-tailer never saw that player's `connect` line — e.g. gateway restarted mid-session, per
   the restart caveat above); reporter info straight off the trigger's own `ChatEvent`, no lookup
   needed. **Not included**: "previous reports against this identity" — no `reports`
   table/store exists yet (§7 sketches one, but nothing writes to it until this pipeline's
   card-delivery/persistence step is built, which is also naturally when the write-path would be
   added) — only prior `audit_log` actions and ban history are available today.
   - Required two new read-only queries, added to the existing stores rather than a new one:
     `AdminStore.listAuditLogForTarget` (matches `audit_log.target`, case-insensitive — that
     column is always a free-text player *name*, e.g. `apps/gateway/src/lib/commands/ban.ts`'s
     `player?.name ?? String(clientId)`, never a structured GUID/IP, so name is the only thing
     it can ever match on) and `BanStore`'s `listBansByGuid`/`listBansByName`/`listIpBansByIp`
     (GUID unless `0`, else name — same §2.4 rule as target resolution; IP always queried
     separately against `ban_ips`, since `bans` has no IP column at all).
   - **Follow-up gap, not fixed here**: `listBansByGuid` will return nothing in practice today —
     `ban-store`'s `recordBan`/`schema.ts` still always insert `guid: null` (a Phase 2-era
     limitation, from before §2.4 found some servers *do* expose GUID via `status()`). Fixing
     that means updating `/ban`'s command handler (`apps/gateway`) to pass `player?.guid`
     through to a new `RecordBanInput.guid` field — a small, separate, apps/gateway-side change,
     intentionally not bundled into this report-pipeline work.
4. **Anti-spam**: per-reporter cooldown (e.g. one report per 60s, configurable) and simple
   duplicate-suppression (same reporter+target within a window collapses into one updated
   card rather than spamming the chat) — otherwise a small flood of `!report` spam becomes a
   Telegram-flood vector. The collapse only applies while the existing card is still
   unresolved (no action taken yet, tracked via `reports.resolved_action` — §7); once a card
   has been acted on (kicked/banned/ignored), a new report against the same target posts a
   **fresh** card instead of re-editing a message admins already treated as closed.

   **Implemented (2026-09-06)**, `packages/report-pipeline`'s `ReportAntiSpam<TCardRef>`: pure
   in-memory tracker (same restart caveat as `SessionTracker` — a gateway restart clears
   cooldowns/open-report tracking; accepted for the same reason, this is short-lived
   flood-control, not the durable history enrichment reads from `admin-store`/`ban-store`/an
   eventual `reports` table). Two decisions worth calling out:
   - **Keyed on the raw `targetName` string from the trigger, not a resolved player identity** —
     dedup needs to behave the same whether the target resolved, was ambiguous, or wasn't found
     (§5 step 2) — "reports against Cheatr123" is one thread to an admin regardless. This also
     means `check()` can run right after trigger detection (step 1), before the rcon/DB round
     trips of resolve/enrich (steps 2-3), skipping them entirely for a cooldown-blocked report —
     an optimization the plan's step numbering doesn't require but doesn't preclude either.
   - **A duplicate collapse is never blocked by cooldown** — only a genuinely *new* report (a
     different target, or the same one after its dedup window has lapsed) can be. Collapsing
     repeats into the same card *is* the anti-flood mechanism for one ongoing complaint;
     gating it behind the same per-reporter cooldown that limits *distinct* new reports would
     fight that. The dedup window also **slides forward** on each collapsed repeat (`track()`),
     so a card being actively re-reported stays open rather than going stale mid-flood.
   - Generic over `TCardRef` (whatever step 5 ends up using to identify a posted Telegram
     message) rather than committing to a concrete shape before that step exists.
5. **Deliver to Telegram**: message posted to the server's bound admin group, with:
   - Header: `🚨 Report: <reporter> reported <target>` + reason if given.
   - Body: the enrichment data from step 3, formatted compactly.
   - Inline keyboard: `Kick` · `Temp Ban (30m)` · `Ban` · `Ignore` · `More info ▾` (expands
     with full status dump / chat history).

   **Implemented (2026-09-06)**, `packages/report-pipeline` — the card content and the
   send/update decision, deliberately **not yet wired into the running gateway** (see below):
   - `report-card.ts` builds all four cards this pipeline can produce — the resolved/disconnected
     one above (disconnected gets `Ignore` only, per step 2), the ambiguous `Select:` one (§5
     step 2), and a **`not-found` card** the plan doesn't explicitly spec (a typo'd or
     fully-expired name still needs *some* response, not silence) — as plain data
     (`{ text, buttons }`, buttons as a framework-agnostic `{ label, action }` shape), no grammy
     dependency. `formatDuration()` renders a session length as `45s` / `3m 12s` / `1h 05m`.
   - `pipeline.ts`'s `processReportTrigger()` is the full step 1-5 orchestration minus button
     handling: checks `ReportAntiSpam` first (before any rcon/DB calls — a cooldown-blocked
     report skips resolve/enrich entirely), resolves the target, enriches it if
     resolved/disconnected, builds the right card, and sends or updates it through an injected
     `CardSender<TCardRef>` interface (`send`/`update`), generic over whatever a real Telegram
     send ends up returning as a reference (chat id + message id, most likely) — the same
     "narrow injected interface, no concrete framework dependency" pattern as every other piece
     of this package.
   - **Deliberately not done here**: actually calling the Telegram Bot API. `apps/gateway` has
     no `InlineKeyboard`→`ReportCardButton[][]` mapping, no `CardSender` implementation over
     grammy's `bot.api`, no per-server `GameLogTailer` instance wired to its `reportTrigger`
     event, and no config plumbing for `ServerConfig.logSourceConfig` (already in the schema,
     unused until now) as each server's `COD2_LOG_PATH`. That wiring is significant on its own
     and is more naturally done together with step 6 below: the callback button payload
     (`ReportCardAction`) has to be encoded into a real `callback_data` string (Telegram's
     64-byte limit rules out embedding raw player names — a short server-side report id looked
     up in an in-memory map is the likely shape, mirroring `STATUS_REFRESH_CALLBACK_DATA`'s
     existing simple-string precedent in `apps/gateway/src/lib/commands/status.ts`), and
     designing that separately from the handler that parses it risks redoing it once the
     handler's actual needs are clear.
6. **Action execution**: button press → grammy callback handler → permission check → RCON
   command via `rcon-client` → on success, edit the Telegram message to show the resolved
   state (who acted, what action, timestamp) and write the audit log row. **Decided**: every
   kick/ban/tempban also fires an `rcon say "<target> was <action> by an admin"` broadcast
   into the game for transparency (§6) — not silent, not optional per-action (a per-server
   opt-out toggle can be added later if a community wants it, but the default is on).

   **Temp-ban mechanism (decided)**: per the §2.4 caveat, native `tempBanClient`'s duration is
   a server-wide cvar, not a per-call argument, and likely doesn't survive a restart — unfit
   as the source of truth for an admin-chosen "30m". So `Temp Ban` does **not** call
   `tempBanClient`: it calls `banClient`/`banUser` — the same native call as a permanent
   `Ban`, GUID written to `ban.txt` — and inserts a `bans` row with `expires_at` set (a
   permanent `Ban` leaves `expires_at` null; the two buttons differ only in that field). The
   gateway's expiry-enforcement poller (§5.7, generalized beyond just GUID-0) calls
   `unbanUser`/removes the `ban.txt` entry once `expires_at` passes. This makes `bans` and
   `ban_ips` symmetric — both gateway-timed — and `tempBanClient`'s own duration semantics are
   never relied on.

   **Implemented (2026-09-06)**: `apps/gateway`'s `executeModerationAction()`
   (`lib/moderation-actions.ts`) is the one place implementing kick/ban/tempban plus the §5 step
   7 GUID-vs-IP branching — rcon call, `ban-store`/`admin-store` writes, and the moderation
   broadcast, all in one function shared by `/kick`/`/ban`/`/tempban` **and** the report card's
   buttons, so both call paths ban a target identically. Building this surfaced (and fixed) two
   Phase-2-era bugs now that §2.4's GUID finding applies: `/ban` previously always called
   `banUser` unconditionally — a silent no-op for a GUID-0 target, i.e. the common case here —
   with no IP fallback at all; and `/tempban` was hardcoded IP-only even when a real GUID was
   available. Both commands now go through the same branching as the report card. `/ban` and
   `/tempban` also now require the target still be connected (previously `/ban` didn't check),
   since with proper GUID/IP branching there's nothing left to ban by once they're gone. The
   broadcast text stays a plain player-facing verb ("banned"/"kicked") regardless of which path
   was taken — the "(GUID unavailable)" detail is for the admin-facing result label only, not
   something players need to see in a chat announcement.

   The report-card button wiring itself (`apps/gateway/src/lib/reports.ts`): a `ReportRegistry`
   maps a short numeric id (embedded in `callback_data`, well under Telegram's 64-byte limit —
   real player names are never encoded into it) to the message's chat/message id, its original
   `ReportTrigger`, and the resolved `ReportActionContext` from report-pipeline's `pipeline.ts`.
   `GatewayCardSender implements CardSender<string>` over `bot.api.sendMessage`/
   `editMessageText`, using that same id as the `TCardRef` anti-spam already tracks — one id
   serves both purposes. `reportActionCallback` handles all six button kinds: `kick`/`tempban`
   (moderator+) and `ban` (admin+) via `executeModerationAction`; `ignore` clears the anti-spam
   dedup entry (§5 step 4) via `resolve()` so a later report gets a fresh card; `select`
   re-resolves one ambiguous candidate (§5 step 2) into a full card via a fresh `status()` call
   plus `enrichReport`/`buildReportCard`, reusing `deriveReportActionContext` (exported from
   `pipeline.ts` for exactly this reuse) rather than re-deriving that mapping; `more-info`
   answers with an alert popup showing `ReportCard.detailText` (full, untrimmed chat history +
   full GUID/IP — a new field added to `ReportCard` for this, since the card's own `text` only
   shows the last 3 lines compactly per §5 step 5).

   **Wired (2026-09-06)**: `main.ts` now builds the shared `GatewayDeps` (moved `ReportRegistry`/
   `ReportAntiSpam`/`sessionsByServer` there from `bot.ts`, so both the callback handler and the
   tailer wiring below see the same instances) and calls the new `startReportTailers(servers,
   deps, bot)` (`apps/gateway/src/lib/report-tailers.ts`) right after `createBot`. For each
   configured server with both a log path (`ServerConfig.logSourceConfig` — populated from
   `COD2_LOG_PATH` for the bootstrapped server via a new `GatewayConfig.logPath`, in the schema
   since Phase 2 but unread until now) and a bound Telegram chat (`/bindserver`), it starts a
   `GameLogTailer`, registers it in `sessionsByServer`, and wires its `reportTrigger` event to
   `handleReportTrigger()`. A server missing either prerequisite is skipped with a `console.warn`
   — RCON-only operation (no report automation) stays a valid configuration, not an error.
   **Known limitation, accepted for now**: this snapshot of `servers` is taken once at startup —
   a server bound to a chat via `/bindserver` *after* the gateway starts won't get a tailer until
   the next restart. Revisit (e.g. `/bindserver` starting a tailer on the spot if one doesn't
   exist yet) if that turns out to matter in practice; not fixed here to keep this change to
   startup wiring. **Not done**: no signal-handling/graceful-shutdown for the started tailers
   (`startReportTailers` returns them for exactly this, but nothing calls `.stop()`) — matches
   this codebase's existing style (the expiry-poller's `setInterval` isn't cleared on shutdown
   either); revisit together if that ever needs to change.
7. **GUID-0 fallback**: if the target's GUID is `0`/blank, **both** the `Ban` and
   `Temp Ban (30m)` buttons execute an IP-based ban — inserting a row into the `ban_ips` table
   (§7), with `expires_at` set for temp bans and left null for permanent ones — since the game
   binary can't ban by IP natively, and (§2.4) `tempBanClient` degrades to a bare kick for
   GUID 0 with no enforced duration on its own. Routing temp bans through `ban_ips` too, rather
   than only `Ban`, is what actually gives GUID-0 temp bans a duration. Enforcement is a
   gateway-owned poller, generalized to do two jobs on the same fixed interval (start at 10s,
   configurable): (a) run `status` against every configured server and kick any connected
   player whose IP matches an active `ban_ips` row (`expires_at` null or in the future) — the
   GUID-0 case; and (b) scan `bans` for rows whose `expires_at` has just passed and call
   `unbanUser`/remove them from `ban.txt` — the GUID-based temp-ban expiry from step 6 above.
   This poller is a third event source alongside log-tailing and Telegram commands (§3
   diagram) — it's the one place the gateway acts without being triggered by an external
   event. Both buttons label the resulting
   card action as "IP ban (GUID unavailable)" / "IP temp ban (GUID unavailable)".
   - **Known limitations, accepted for now**: (a) the poll interval means a banned GUID-0
     player who is already connected, or who reconnects between polls, has up to one interval's
     worth of time to act before being kicked; (b) IP bans don't survive the player getting a
     new IP (dynamic IP / VPN / reconnecting through a different network) — the ban silently
     stops working rather than erroring; (c) an IP ban can collaterally kick an unrelated
     player who shares that IP (NAT/shared connection). Since §2.4 flags GUID 0 as possibly the
     *common* case rather than a rare edge case on the target server, these aren't corner-case
     caveats — they may be the primary ban mechanism's real-world failure modes, and should be
     re-assessed once the Phase 3 GUID verification (§9) is done.

   **Implemented (2026-09-06)**: job (a) (kick-on-sight for active `ban_ips` rows) already
   existed from Phase 2 as `ban-store`'s `runIpBanSweep`. Job (b) — the GUID-based temp-ban
   expiry this section calls for — is new: `runBanExpirySweep` (same package, its own function
   rather than folded into `runIpBanSweep`, so each stays independently testable) scans `bans`
   for rows past `expires_at`, calls `unbanUser(guid)` for any with a real GUID (skipped for a
   `null` one — those were never written to `ban.txt` via this path to begin with), then drops
   the row. `apps/gateway`'s `expiry-poller.ts` runs both sweeps on the same interval, per the
   "same fixed interval" requirement above. Required extending `BanStore`/`bans`'s
   `RecordBanInput` with `guid`/`expiresAt` fields (previously `recordBan` always inserted
   `guid: null, expiresAt: null` — see step 6's note on the `/ban`/`/tempban` bugs this
   uncovered) and two new store methods, `listExpiredBans`/`expireBan`, mirroring the existing
   `ban_ips` pair.

## 6. Server status & management

- `/status [server]` — condensed `status` output (map, player count/max, uptime) as a
  Telegram message, with a manual inline "Refresh" button that re-edits the same message on
  click. **No background timer** — it only ever calls the API in response to a button press,
  never on an interval.
- `/kick <player>`, `/ban <player> [reason]`, `/tempban <player> [duration]`,
  `/unban <guid-or-ip>` — direct commands taking a player name/slot or ban target, for when an
  admin doesn't want to open `/players` first. Same permission checks, same RCON/DB mechanism,
  and same audit logging as the button-driven paths (§5.6) — `/tempban` in particular goes
  through the `banClient`+`expires_at`+expiry-poller flow, not native `tempBanClient`. These
  give Moderators (§4, kick/tempban only, no `/ban`) a way to act proactively instead of only
  reacting to an in-game `!report`.
  - **`/bans [--server <alias>]`, implemented (2026-09-07)**: lists currently active bans —
    `BanStore.listActiveBans` (new, mirrors `listActiveIpBans`: `bans` rows with `expiresAt`
    null or in the future) alongside the existing `listActiveIpBans`, admin-gated like
    `/ban`/`/unban`. Added so an admin has something to read a GUID off of before running
    `/unban <guid-or-ip>` — previously the only way to find a banned GUID was `/auditlog` or
    `listBansByGuid`/`listBansByName` (history lookups, not exposed as a command).
  - **`/unban <guid-or-ip>` fixed to actually match this section's own signature (2026-09-07)**:
    previously GUID-only, and never touched the `bans` table (rcon `unbanUser` call only), so a
    manually-unbanned GUID kept showing up in the new `/bans` list forever. Now: an IPv4-shaped
    argument goes to the new `BanStore.unbanIp` (stamps `unbannedAt`, no rcon call — an IP ban is
    never written to `ban.txt`, §7); anything else is treated as a GUID, calling `unbanUser`
    *and* the new `BanStore.unbanByGuid` (same stamp, on the `bans` table). Both `bans`/`ban_ips`
    gained a nullable `unbanned_at` column (migration `0001_illegal_omega_red.sql`) rather than
    deleting the row outright, so `listBansByGuid`/`listBansByName`/`listIpBansByIp`'s ban
    *history* (§5 step 3) still shows an unbanned entry — only `listActiveBans`/`listActiveIpBans`
    (and, incidentally, `listExpiredBans`/`listExpiredIpBans`, so the expiry poller doesn't
    reprocess an already-unbanned row) filter on it being `null`.
- `/players [server]` — live player list with per-player inline `Kick`/`Temp Ban (30m)`/`Ban`
  shortcuts (same action path as the report card, just triggered manually).
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
- `bans(id, server_alias, guid, name, reason, banned_by, banned_at, expires_at)` — GUID-based
  bans (and temp bans, via `expires_at`). The initial block is enforced natively by the game
  binary via `banUser`/`banClient` (GUID written to `ban.txt`); **expiry is gateway-enforced**
  (§5.6/§5.7), not via `tempBanClient`'s own duration semantics — see the caveat in §2.4/§5.6.
  `tempBanClient` itself is not called anywhere in our ban flow; it's referenced in §2.4 purely
  as prior-art protocol knowledge (its GUID-0 behavior).
- `ban_ips(id, server_alias, ip, reason, banned_by, banned_at, expires_at)` — IP-based bans
  used only for the GUID-0 fallback path (§5.7), for both permanent and temp bans; enforced by
  the gateway's own status-poller since the game binary has no native IP-ban support (the same
  poller also drives `bans`' temp-ban expiry — §5.6/§5.7). Kept as a separate table from `bans`
  rather than an `ip` + `is_ip_fallback` column pair on `bans`, because the two are enforced by
  completely different mechanisms for the *initial* block — native ban-file vs. gateway
  poll-and-kick — even though expiry enforcement is now shared logic; querying "what does the
  poller need to check right now" should be a plain scan of one table, not a filtered scan of
  the general ban history.
- `reports(id, server_alias, reporter_name, reporter_guid, target_name, target_guid,
  target_ip, reason, raw_chat_line, created_at, resolved_action, resolved_by, resolved_at)`
- `audit_log(id, actor_telegram_id, action, target, server_alias, reason, source, detail_json,
  created_at)` — `reason` and `source` (`telegram_button` / `telegram_command` / `auto`, per
  §4) are explicit columns rather than buried in `detail_json`, since `/auditlog` (§4) needs to
  filter/display them directly; `detail_json` holds any action-specific extra data (e.g. the
  raw command text for `/rcon`, §6).

`rcon_password` and any other secrets stored **encrypted at rest** (e.g. libsodium secretbox
with a key from env), not plaintext in the DB — the gateway is the only thing that ever needs
the decrypted value. Note the limits of this: the decryption key lives in env on the same host
as the database, so this protects against a leaked DB dump/backup, not against full compromise
of the host itself (which gets the key too). Postgres runs on the same host (§3.2); back it up
with routine `pg_dump` snapshots **shipped off-host** (e.g. synced to object storage or a
second machine) — a same-host-only backup is lost together with the primary on any host
failure, and this DB now holds durable ban/audit history, not just cache-able state.

## 8. Security notes

- RCON UDP is spoofable/floodable (see §2.4) — firewall each game server's RCON port to only
  accept from the gateway's egress IP where the hosting provider allows it; recommend CoD2x's
  built-in rate limiter regardless.
- Telegram side: every mutating command/button goes through a role-check middleware; deny by
  default for unknown Telegram user IDs.
- Rate-limit outgoing RCON commands from the gateway itself (a burst of Telegram button
  clicks or a report flood shouldn't hammer the game server).
- Validate/sanitize anything interpolated into an RCON command (player-supplied report
  reasons, chat text, **and player names** — reporter/target names are just as
  player-controlled as chat text, and the mandatory moderation broadcast (§5/§6) echoes the
  target's name via `rcon say` on every kick/ban/tempban) before it could ever be echoed via
  `rcon say` — avoid command/argument injection into the RCON stream. **`/rcon` (§6) is an
  intentional exception** to this rule —
  it's a deliberate raw passthrough for the owner, not a bug — but that's exactly why it's
  owner-only and always logged verbatim to `audit_log`, unlike every other command path.
- Respect Telegram's own API rate limits (roughly 30 messages/sec bot-wide, ~20/minute per
  group) when designing anything that posts/edits messages programmatically rather than in
  direct response to one user click — a burst of report cards during a raid, or the moderation
  broadcasts (§5/§6) firing for several near-simultaneous actions, should back off/coalesce
  rather than firing one API call per event, or Telegram will start silently dropping/delaying
  updates. `/status`'s Refresh button (§6) is manual/button-only with no background timer, so
  it isn't a source of this risk on its own.

## 9. Phased delivery plan

- **Phase 0 — foundations**: `rcon-client` lib with `status`/`kick`/`banClient`/`banUser`/
  `unban`/`say`/`map`, unit-tested against a mock UDP peer. Single hardcoded server via env
  vars, no DB yet.
- **Phase 1 — Telegram MVP**: `apps/gateway` wraps Phase 0 lib; grammy bot exposes
  `/status`, `/players`, `/kick`, `/ban`, `/unban`, `/map`. Owner-only, single admin (env
  var), no roles yet. **No `audit_log` yet either** (it lands with `admin-store` in Phase 2) —
  Phase 1 moderation actions are unaudited by design; acceptable for a single-owner MVP with no
  role delegation, since the owner is the only actor who could act anyway.
- **Phase 2 — admin & data layer**: `admin-store`/`ban-store` on Postgres via Drizzle;
  `/addadmin`/`/removeadmin`/`/setrole`, audit log, multi-server support (`servers` table,
  per-group binding). Also where `/tempban` and the `Temp Ban` shortcuts (§6) become usable —
  they need `ban-store`'s expiry-enforcement poller (§5.6/§5.7), which needs Postgres. This is
  also the first phase where the Moderator role (§4) has any real capability, since roles
  (and therefore Moderators) don't exist before it.
- **Phase 3 — report automation**: `log-tailer` + `report-pipeline`; `!report <name>` chat
  trigger → enriched Telegram card → inline-button actions → anti-spam cooldown → GUID-0
  IP-fallback ban path. **Confirmed (§2.4)**: GUID 0 is the common case on the target server,
  not a rare fallback — build the GUID-vs-IP correlation logic (§5.3, §7) with that as the
  default path from the start, not as an edge case bolted on later.
- **Phase 4 — nice-to-haves** (borrow from RCM): GeoIP-enriched player info on report cards,
  proxy/VPN auto-kick list, bad-nickname auto-kicker, `!getss`-style screenshot capture if an
  anticheat hook is available, periodic stats digest posted to the Telegram group, and
  investigate a GSC-hook-based chat **mute** for Moderators (§4) if CoD2x exposes one — dropped
  from v1 since vanilla RCON has no native per-player mute.
- **Ops: self-updating from Telegram** — see §13. Operational tooling around the installer
  (§12), not a bot feature — independent of the phases above; doesn't block, and isn't blocked
  by, Phase 3/4.

## 10. Open questions for the user

- ~~Hosting topology~~ — **resolved**: gateway runs on the same host as the CoD2 server(s).
- ~~CoD2x acceptable?~~ — **resolved**: yes, target server(s) run CoD2x — used for its UDP
  rate limiter (§8); the HTTP/WS push adapter idea was considered and **dropped** (§2.4) since
  same-host removes its only advantage over log-tailing.
- ~~SQLite vs Postgres~~ — **resolved**: Postgres from the start (§3.2, §7).
- ~~In-game ban feedback~~ — **resolved**: every kick/ban/tempban broadcasts via `rcon say`
  (§5 step 6, §6), not silent.
- ~~Webhook vs long-polling~~ — **resolved**: long-polling (§3.2) — no public HTTPS endpoint
  needed on the game server host.

All open questions are resolved — plan is ready to move into Phase 0 implementation whenever
you want to start. One item was flagged rather than open — whether GUID 0 is the common case on
the actual target server (§2.4) — and has since been **confirmed empirically** (2026-09-05,
real client connecting over LAN got GUID 0 on the first attempt): treat it as the default case
for the GUID-vs-IP correlation logic (§5.3, §7) when Phase 3 is built, not an edge case.

## 11. Testing & dev environment

Decided ahead of Phase 0 so every phase lands with tests from the start, not bolted on later.

### 11.1 Local dev stack

- **CoD2 dedicated server**: run a real `cod2_lnxded` via Docker
  ([bgauduch/call-of-duty-2-docker-server](https://github.com/bgauduch/call-of-duty-2-docker-server),
  already in §Sources) rather than a hand-rolled protocol fake. **Scaffolded**: root
  `docker-compose.yml` (`cod2_server` + `postgres` services) and `docker/cod2server/main/`
  (`server_mp.cfg`/`punkbuster.cfg`, adapted from the upstream project's defaults). The
  dedicated server *binary* is freely distributed, but the game's `.iwd` data files are **not**
  — you need your own legitimate CoD2 copy to extract them from; see
  `docker/cod2server/README.md` for the one-time setup step this requires before the container
  will actually boot.
  - **Two separate volumes, not one** (§2.4 has the full investigation/fix, 2026-09-06):
    `docker/cod2server/main` (`fs_basepath`, game data) is seeded into a **named volume** —
    an upstream bug (bgauduch/call-of-duty-2-docker-server#94) breaks a bind mount there — so
    it never reaches the host filesystem. `docker/cod2server/homedir` (`fs_homepath`, set via
    `+set fs_homepath /home/cod2/homedir` at launch) *is* a real bind mount, and that's what
    `games_mp.log` lands under: `docker/cod2server/homedir/main/games_mp.log` on the host. Per
    §6 the gateway always reads the log straight off the local filesystem (never over SSH), so
    in dev the gateway process (run natively via `nx serve`, not containerized) points
    `log-tailer` at that host path (`COD2_LOG_PATH` in `.env`) — same code path as prod, just a
    bind mount standing in for "same host."
  - RCON and game traffic share one UDP port (`28960`, per the Quake3-derived protocol, §2.4);
    the compose file binds it (and the game's TCP/UDP `20500`/`20510` ports) to `127.0.0.1`
    only, matching the same-host/localhost connectivity model from §6.
  - `server_mp.cfg`'s `rcon_password` is set by the game engine from that file, not from
    `.env` — the two must be kept in sync by hand (documented in
    `docker/cod2server/README.md`); nothing automates that today.
- **Postgres**: a `postgres:16-alpine` service in the same `docker-compose.yml`, port bound to
  `127.0.0.1` only, data on a named volume so it survives restarts — no reason to diverge from
  prod's Postgres choice (§3.2) even in dev.
- **Telegram**: a **separate dev bot** registered via @BotFather (e.g. `cod2admin_dev_bot`),
  added to a private test group you control, with its own `OWNER_TELEGRAM_ID` claim. Dev config
  never touches the real admin group/bot token — full isolation, and it means dev testing can
  never leak a moderation action or spam into a real community's chat.
- All of the above wired through `docker-compose.yml` (Postgres + CoD2 server) plus a
  root `.env` (gitignored) holding: dev bot token, dev `OWNER_TELEGRAM_ID`, dev RCON password
  (kept in sync with `server_mp.cfg` by hand, see above), dev Postgres connection string, and
  the bind-mounted log path. `.env.example` is checked in with placeholder values as the
  template — copy it to `.env` and fill in real values before running anything.

### 11.2 Automated test pyramid (runs in CI, no Docker/game binary needed)

- **`rcon-client`**: unit tests against an in-process mock UDP peer (Node `dgram`) — already
  called for in Phase 0 (§9). Covers OOB packet framing, `status`/`getinfo` parsing, and
  malformed/short-packet edge cases without any real game server.
- **`log-tailer`**: fixture-based tests against checked-in sample `games_mp.log` excerpts
  (`packages/log-tailer/test/fixtures/*.log`) covering: connect/disconnect, `say`/`sayteam`,
  color-code-embedded names, a GUID-`0` connect line, and `!report` trigger lines (including the
  "no `!` prefix → ignored" case from §5 step 1). Fixtures should be captured from the real
  Docker server (§11.1) at least once so they reflect actual format, then frozen as fixtures —
  no live server needed to run the tests afterward.
- **`report-pipeline`**: unit tests with an injected fake `rcon-client` (canned `status`
  responses) and fake `ban-store`/`admin-store` — covers fuzzy name matching, the ambiguous-match
  `Select:` button path (§5 step 2), anti-spam cooldown/dedup (§5 step 4), and the GUID-0
  IP-fallback branch (§5 step 7), all without a real DB or UDP socket.
- **`admin-store`/`ban-store`**: integration tests against a real Postgres — thin repository
  layers over Drizzle are exactly the kind of code that's not worth mocking a DB for. A
  Postgres service container in CI (GitHub Actions `services:` — this is unrelated to, and
  lighter-weight than, the CoD2-server e2e decision below) is fine here since it needs no game
  binary, just `postgres:<version>`.
- **Telegram command router**: grammy supports constructing fake `Context`/`Update` objects
  directly, so command/permission-middleware logic (`/addadmin`, role checks, etc.) is tested by
  asserting on calls into gateway logic — never hitting Telegram's real API in CI.
- **Decided: no docker-compose end-to-end suite in CI.** A full stack (real CoD2 server + gateway
  + Postgres) run in CI adds meaningful time/flakiness for coverage the fixture+mock layers above
  already get at the unit level. End-to-end validation instead happens manually (§11.3),
  including the one thing no fixture can cover — a real game client actually connecting and
  chatting.

### 11.3 Manual end-to-end checklist (local only, not CI)

Run against the Docker CoD2 server + dev Telegram bot from §11.1. Requires an actual CoD2 game
client to connect to your own dev server — the Docker image alone only hosts the server, it can't
generate real player connect/chat traffic, and this is also where the GUID behavior verification
flagged in §2.4/§9 has to happen (a scripted fixture can't tell us what a real client's GUID
actually looks like against this server config).

- `/status`, `/players` — real `status` output round-trips through Telegram correctly.
- `/kick`, `/ban`, `/unban`, `/tempban` (+ its gateway-driven expiry, §5.6) via direct commands.
- `!report <name> <reason>` in-game → card appears in the dev group with correct enrichment
  (§5 step 3) → each button (`Kick`/`Temp Ban`/`Ban`/`Ignore`/`More info`) → verify `ban.txt`
  and the `bans`/`ban_ips` tables end up in the expected state.
  - **Partially confirmed (2026-09-06)**: the full pipeline was smoke-tested against the real
    dev server + dev Telegram bot (`@CoD2MPRusDevBot`), `/bindserver default` bound live for the
    first time, then a synthetic `J`/`say;...!report...` pair appended directly to the real
    `games_mp.log` (no real client connected, so the target was live-unresolvable by design —
    exercises the **disconnected-target fallback**, §5 step 2). Confirmed working end-to-end:
    trigger detection → log-tailer session cache resolution → enrichment → card delivery (correct
    reporter/target/reason, "target disconnected" label, `Ignore`-only keyboard as expected for
    this path) → `Ignore` button press → message edited to the resolved state → anti-spam
    dedup entry cleared, all with no gateway errors. **Not yet exercised this way**: the
    resolved-live path (needs a real client actually connected — a synthetic log line alone
    can't appear in a live `status()` call) and therefore `Kick`/`Temp Ban`/`Ban`, `Select:` for
    an ambiguous match, and `More info`. Needs a real CoD2 client connected to close out the rest
    of this checklist item.
- Ambiguous-name report → `Select:` buttons → resolves into the normal card (§5 step 2).
- GUID-0 path, if/once confirmed reachable on the target server config (§2.4): confirm both
  `Ban` and `Temp Ban` route through `ban_ips` and the expiry-poller actually kicks/unbans on
  schedule (§5 step 7).
- Moderation broadcast (`rcon say ...`) is visible in-game on every kick/ban/tempban (§5 step 6).
- `/addadmin`, `/setrole`, `/removeadmin`, `/auditlog` — role management and audit trail.
- `/rcon <raw command>` — owner-only, and confirm it's the one path where argument sanitization
  (§8) is intentionally skipped.

### 11.4 CI wiring

`nx affected -t lint test` on every PR runs §11.2's unit/fixture/mock-based tests plus the
Postgres-service-container store tests — fast, no Docker CoD2 image or real Telegram token
required, so it never depends on secrets that would need to live in CI. The §11.3 manual e2e
checklist is a pre-release gate run locally, not a CI job.

## 12. Installing on a production server

Admins install from a GitHub Release rather than building from source — full walkthrough and
prerequisites in `installer/README.md` (condensed Russian version in `PLAN-ru.md`). In short:

```sh
curl -s https://api.github.com/repos/constantant/cod2admin/releases/latest \
  | grep browser_download_url | grep -v gateway | cut -d '"' -f 4 | xargs curl -LO
tar -xzf cod2admin-*.tar.gz
cd cod2admin-*/
sudo ./install.sh
```

The GitHub API call resolves whatever the current latest release's asset is named, so there's
no version number to look up or substitute by hand — this always fetches the newest release.
`scripts/release.sh` builds and publishes `cod2admin-<version>.tar.gz` (`install.sh` + its
README + the built gateway bundle, vendored with its real non-workspace deps — see
`scripts/build-installer-bundle.sh`) as the one asset a human needs, so there's never more than
one thing to download by hand. Since §13.2/§13.3, the release also carries two more assets — the
inner gateway tarball and its `.sha256`, published directly so the gateway's own `/update`
command can fetch them without unwrapping a tarball-inside-a-tarball — which is why the curl
one-liner above filters with `grep -v gateway`.

`install.sh` installs Node.js and Postgres if missing, validates the Telegram token and RCON
reachability live (real API/UDP calls, not just presence checks) before writing any config, and
falls back to a supervised background process on hosts without systemd/OpenRC. Verified by
extracting a real release archive into a clean container with no pre-installed dependencies and
confirming the gateway actually started and connected, end to end, using a real dev Telegram
token and a live RCON probe against the real dev CoD2 server — not just that the script exited
0.

## 13. Self-updating from Telegram (implemented and live-tested end-to-end 2026-09-07 — §13.2 through §13.5 all landed, including the boot-time success confirmation, and `/update` was exercised for real against the real v1.0.0 release)

Admins running the bot on their own servers (§12) currently have no way to learn a new version
exists, or to install it, other than re-running the installer's curl one-liner by hand. This adds
an update-check notification plus an owner-triggered in-place update, both over Telegram.

### 13.1 Constraint: the gateway process has no privilege to update itself

`install.sh` (§12) runs the gateway as an unprivileged system user (`cod2admin`, no shell, no
sudo) under systemd/OpenRC supervision — correct, and not changing for this feature. That means
whatever runs in response to a `/update` command cannot itself restart its own service or
overwrite files it doesn't own. The design below crosses that privilege boundary with a narrow,
fixed-command `sudo` rule rather than loosening the service's own permissions.

### 13.2 Version-check + notification (implemented 2026-09-07)

- `apps/gateway/src/lib/version-check-poller.ts`'s `startVersionCheckPoller`, same shape as the
  existing ban/IP-ban expiry poller (§5.7, `expiry-poller.ts`) — a thin `setInterval` wrapper
  around a directly-testable `checkForNewVersion(deps, bot)`. Checks
  `api.github.com/repos/constantant/cod2admin/releases/latest` (`github-releases.ts`) every 6h
  (a version check doesn't need §5.7's ~10s cadence) and compares the tag against the running
  version (`version.ts`'s `getRunningVersion()`, reading `apps/gateway/package.json` at runtime
  via the same package-root trick `commands/help.ts` uses for its doc files).
- On a new tag, DMs the **owner only** (not all admins — updating is an owner-level decision,
  matching who can already run `/rcon`, §6), resolved via `AdminStore.listAdmins()` filtered to
  `role === 'owner'` (no dedicated lookup method exists). Message includes the release's own
  notes (GitHub release `body`, itself sliced from `CHANGELOG.md` at release-creation time by
  `scripts/release.sh` — the poller doesn't re-slice anything itself). Notifies once per new tag
  (`deps.lastNotifiedTag`, only updated after a successful send, so a transient Telegram failure
  is retried next tick rather than permanently suppressed) and is a no-op entirely when self-update
  isn't configured on this install (see §13.5's `UPDATE_STAGING_DIR`).

### 13.3 `/update` command (implemented 2026-09-07)

Owner-only, same permission tier as `/rcon`. `apps/gateway/src/lib/commands/update.ts`.

1. Re-checks latest release itself (doesn't trust the poller's last result — may be stale, or
   nobody's seen the notification yet), replies with a confirmation prompt (inline `Update` /
   `Cancel`, tracked in a short-id `UpdateRegistry` mirroring `ReportRegistry`, §5 step 6) — this
   restarts the service, so it's never a one-shot no-confirm command.
2. On confirm, downloads two assets directly into `staging/` (`deps.updateConfig.stagingDir`,
   created by `install.sh`): the gateway tarball and its `.sha256` — published as their own
   release assets (not nested inside the human-facing archive) specifically so this step doesn't
   need to unwrap a tarball-inside-a-tarball; see the note on this in §12.
3. Verifies the downloaded tarball's checksum against the downloaded `.sha256` (`update-apply.ts`'s
   `verifyChecksum`) before writing anything `apply-update.sh` would act on — aborts and cleans up
   both files on a mismatch, no audit log, nothing staged.
4. Writes `staging/pending-update.env` (`CHAT_ID=<chat id>`) — the exact marker
   `installer/apply-update.sh`'s failure-alert path already reads (built and tested before this
   command existed, §13.4/§13.5).
5. Audit-logs the action (`action: 'update'`, `target: <tag>`, `source: 'telegram_command'`), then
   fires `sudo <bin>/apply-update.sh <staged-tarball>` (`update-apply.ts`'s `runApplyUpdate`,
   `child_process.spawn` detached + `unref()`) and replies "Applying update…" — deliberately
   **not awaited to completion**: `apply-update.sh` restarts the service partway through, which
   kills the very gateway process that just spawned it, so there may never be a normal exit to
   observe.
6. **Implemented (2026-09-07)**: the gateway process itself dies as part of step 5's restart, so
   it's the **new** process that confirms success — `apps/gateway/src/lib/update-boot-check.ts`'s
   `checkPendingUpdateOnBoot(deps, bot)`, awaited in `main.ts` *before* `bot.start()`. If
   `staging/pending-update.env` is still there, it posts "✅ Updated to vX.Y.Z" to the marker's
   chat id and removes the marker; if there's nothing to find (every normal boot), it's a no-op.
   Has to run and finish before `bot.start()` specifically because `apply-update.sh`'s own health
   check is "the log shows 'started as @...'", which only happens once `bot.start()`'s `onStart`
   fires — running the check earlier than that guarantees it always sees the marker first.
   - **Found and fixed a real race while building this**: `apply-update.sh`'s *rollback* path
     restarts the **old** version after a failed update — and that old process's own boot-time
     check has no way to tell "this restart followed a failed update" from "this restart followed
     a successful one," so a leftover marker would make it falsely announce "✅ Updated" for a
     version that never changed. Fixed by having `apply-update.sh` capture the marker's chat id
     and delete the marker itself *before* the rollback restart (not after, and not left to the
     new-process check at all) — ownership of the marker is now: the confirm handler writes it,
     the **successfully** updated new process consumes it, and a **failed** update's rollback path
     deletes it directly without ever handing it to the (old-version) process that boots next.

**Live-tested end-to-end (2026-09-07)**, against the real `v1.0.0` GitHub release and the real dev
Telegram bot: a container running a build that had this command's code but reported itself as an
older version was sent a real `/update`, the owner tapped the real inline `Update` button, and the
whole chain worked for real — download, checksum verification, `staging/pending-update.env`,
`recordAuditLog` (confirmed in Postgres: `704781 | update | v1.0.0 | telegram_command`), the
unprivileged `cod2admin` user invoking `sudo apply-update.sh` for real, the symlink swap to
`releases/1.0.0`, and the service restarting successfully on the real released code. One earlier
attempt in the same session produced no card at all — turned out to be test-setup error, not a
bug: the starting build (a real, older `v0.0.4`) predates this command entirely, so grammy
silently ignored the unmatched `/update` (expected behavior for an unrecognized command, not a
failure) — re-ran against a build that actually has the code, which worked immediately. Also found
and fixed a minor real cleanup gap while verifying: `apply-update.sh`'s success path removed the
downloaded tarball and the pending-update marker but left the `.sha256` file behind in `staging/`
— harmless (overwritten by the next update) but now cleaned up too.

**Step 6 (the boot-time confirmation) live-tested end-to-end too (2026-09-07)**, in a second real
cycle after cutting `v1.0.1` (the first real release to actually contain it — the `v1.0.0` update
above predates it, which is exactly why this needed its own cycle). Confirmed for real: a genuine
`v1.0.0 → v1.0.1` update via a real `/update` tap produced the real "✅ Updated to v1.0.1" message;
a deliberately-broken build applied directly via `apply-update.sh` (bypassing `/update`, to target
the rollback path specifically) rolled back correctly with no false success message from the
rolled-back process and the real "❌ ... failed and was rolled back" alert still arriving — i.e.
the marker-race fix (§13.4 step 6's note) actually holds under a real restart, not just in theory.

**A real, unrelated bug surfaced while cutting `v1.0.1`**: CI (`nx run-many -t lint test build
typecheck e2e`) had been failing on every push since `v1.0.0`, unnoticed because pushes in this
session went out without checking CI status afterward — `packages/report-pipeline`'s
`enrichment.spec.ts`/`report-card.spec.ts` fixtures predated `ban-store` gaining a required
`unbannedAt` field (from the `/bans`/`/unban` work) and never picked it up, breaking
`report-pipeline:typecheck`. Only test fixtures were affected, never library/runtime code, so the
already-published `v1.0.0`/`v1.0.1` release artifacts themselves are unaffected — fixed on `main`
regardless, and verified green with CI's own exact command before pushing.

### 13.4 `apply-update.sh` — the trusted-root half (implemented 2026-09-07)

Root-owned, fixed path (`$INSTALL_DIR/bin/apply-update.sh`, so a custom `--install-dir` still
works — it derives `$INSTALL_DIR` from its own location rather than hardcoding `/opt/cod2admin`),
installed by `install.sh`, invocable via a narrow `sudoers.d/cod2admin` drop-in scoped to exactly
this one script and to arguments under `$INSTALL_DIR/staging/` — not a blanket `NOPASSWD: ALL`.
Deliberately small and dumb, since it's the trusted-root part (`installer/apply-update.sh`):

1. Validates it's running as root, and that its one argument is a `cod2admin-gateway-*.tar.gz`
   file already staged under `$INSTALL_DIR/staging/` (matching the sudoers rule's own scope).
2. **Tar-member safety check** before extracting anything — `tar -tzf`'s member list is rejected
   (no extraction) if any entry is an absolute path or contains a `..` segment. Extraction runs
   as root, so this closes the obvious path-traversal escape a crafted tarball could use.
3. Extracts to `releases/<version>/`, `chown -R root:root`, `chmod -R a+rX` — read/execute for
   the `cod2admin` service user, no write access to its own code.
4. Records the current symlink target, then repoints `current` at the new release
   (`ln -sfn releases/<version> current`).
5. Restarts the service and waits for the "started as @..." line — both via the shared
   `restart_service()`/`verify_running()` in `installer/lib/service.sh` (also used by
   `install.sh`'s `register_service()`), so applying an update never touches the systemd
   unit/OpenRC init script, only the symlink.
6. **On failure**: captures the `staging/pending-update.env` marker's chat id and deletes the
   marker *before* rolling back (not after — see §13.3 step 6's note on why: the **old** version
   is about to restart too, and its own boot-time check has no way to tell a failed-update restart
   from a successful one, so a lingering marker would make it falsely claim success). Then
   repoints the symlink back to the previous release, restarts again, and sends the Telegram
   failure alert itself via a direct `curl` call to `api.telegram.org` using the captured chat
   id — it's the only thing that can see the failure. Degrades to log-only (no Telegram call) if
   no marker was ever found or there's no bot token — which also makes the script independently
   usable by an admin running it by hand, without `/update` involved at all.
7. **On success**: prunes old release directories (keeps the current one + 1 previous) and sends
   nothing itself — deliberately leaves `staging/pending-update.env` in place for the **new**
   process's own boot-time check (`update-boot-check.ts`, §13.3 step 6) to find, confirm, and
   clean up.
8. A `mkdir`-based lock (`update.lock`) rejects a second concurrent invocation rather than racing
   with itself. Every step is appended to `$INSTALL_DIR/update.log`, timestamped, since this runs
   unattended and has to be debuggable without a terminal attached.

**Deliberately not done here** (belongs to §13.2/§13.3, later, since it needs `apps/gateway`):
downloading the release, checksum verification, writing the pending-update marker, and the
gateway-side boot check that posts the Telegram success message. This script only applies an
already-staged, already-trusted tarball.

### 13.5 Installer layout changes (implemented 2026-09-07)

Concrete layout, refined from the sketch above while implementing it — everything stays under the
existing `/opt/cod2admin` (no new top-level system path introduced):

```
/opt/cod2admin/                  root:root 755 — stable, never swapped
  .env                            cod2admin:cod2admin 600 — same path as before §13.5
  bin/
    apply-update.sh                root:root 700
    lib/service.sh                 root:root 644 (sourced, not executed directly)
  releases/
    <version>/                     root:root; dirs 755, files a+rX — immutable payload
  current -> releases/<version>    symlink, repointed atomically (ln -sfn)
  staging/                         cod2admin:cod2admin 700 — writable scratch for the future /update
  cod2admin.log / .pid / start.sh  only used by the no-systemd/no-OpenRC fallback, as before
```

`.env` never moves to `/etc` — it just stops being inside the *versioned* `releases/<version>`
subtree, which is all this needed. The systemd unit's `EnvironmentFile=` path is unchanged;
`WorkingDirectory=`/`ExecStart=` (and OpenRC's `directory=`/`command_args`, and the no-supervisor
fallback's `start.sh`) now point at `current/` instead of the install root directly. `cod2admin`
never gets write access to `/opt/cod2admin` itself — only to `staging/` — so a compromised
gateway process can't modify its own release code.

- `install.sh`'s `install_app()` extracts into `$RELEASES_DIR/<version>` (parsed from the bundled
  tarball's filename) instead of flat into `$INSTALL_DIR`, applies the root-owned/`a+rX`
  permissions above, repoints `current`, and calls the shared `prune_old_releases()`.
- New `install.sh` function `migrate_legacy_layout()` detects the pre-§13.5 flat layout (`.env`
  present, no `current` symlink), stops the service, and moves the whole old install aside to
  `<install-dir>.pre-migration-backup` (kept, not deleted) — `install_app()` then rebuilds the new
  layout fresh from the bundle being installed. Doesn't bother hand-preserving the old `.env`:
  `write_env()` already unconditionally regenerates it from that run's wizard answers on every
  install/reconfigure, migration or not — true before this layout existed too. No admin/ban data
  is affected (that's in Postgres).
- New `install.sh` function `install_update_machinery()` copies `apply-update.sh` + `lib/` into
  `bin/`, and **generates** (not ships as a static file) the sudoers drop-in — using `$BIN_DIR`/
  `$STAGING_DIR`, so a custom `--install-dir` produces a correct rule — validating it with
  `visudo -cf` first and refusing to install it if validation fails (a broken sudoers.d file
  breaks `sudo` system-wide, so this is a hard failure, not a warning) before writing it to
  `/etc/sudoers.d/cod2admin` (mode 440).
- `installer/lib/service.sh` (new): `step`/`info`/`warn`/`die`/`success`, `detect_init_system()`,
  `restart_service()` (new — restarts an *already-registered* service without touching unit
  files, the piece `apply-update.sh` needed standalone), `verify_running()` (now returns 1 on
  failure instead of calling `die()`, so `apply-update.sh` can catch it and roll back — installs
  still `die()` at their own call site, since a first install has nothing to roll back to), and
  `prune_old_releases()`. Sourced by both `install.sh` and `apply-update.sh`, each from its own
  on-disk location — no cross-linking between the temp download dir and the permanent install dir.
- `scripts/build-installer-bundle.sh` now writes a `<tarball>.sha256` alongside the gateway
  tarball; `scripts/release.sh` ships `apply-update.sh`, `lib/`, and the `.sha256` file in the
  release archive alongside `install.sh`/`README.md`.

**Verification**: syntax-checked (`sh -n`) plus a container smoke test (Alpine, the no-systemd/
no-OpenRC fallback path) exercising the actual `apply-update.sh`/`lib/service.sh` code — a good
update (extract → root ownership → symlink swap → restart → verify) and a bad one (same, but the
new version fails to start → automatic rollback to the previous release → failure logged) both
behaved as designed. Caught and fixed one real bug this way: with `$INSTALL_DIR` now root-owned,
the no-supervisor fallback's `cod2admin`-run shell could no longer create `cod2admin.log`/
`cod2admin.pid` by redirection (needs directory write permission it no longer has) — fixed by
having `restart_service()` pre-create and `chown` those two files before ever launching under
that user. **Not verified in this pass**: the full interactive `install.sh` wizard end-to-end
(needs a real Telegram token + reachable RCON + Postgres), `visudo -cf` on a real Linux host (no
`visudo` on the dev machine that implemented this), and real systemd/OpenRC unit restarts
(container test only exercised the fallback path) — needs a manual check on a real box before
this ships in a release, per §12's own past verification approach.

### 13.6 Safety notes

- A checksum over HTTPS from GitHub is the v1 integrity bar — no GPG signing of release artifacts
  yet; worth revisiting if this bot is ever distributed more widely than self-hosted-by-the-author.
- The rollback path (§13.4 step 6) is what makes this safe to trigger from Telegram at all — an
  update that never confirms success within a timeout reverts automatically rather than leaving
  the service down.

### 13.7 Open questions

- Poller interval: is 6h a reasonable default, or should it be configurable per install?
- Should `/update` support pinning to a specific version (rolling back to an older release, not
  just forward to latest)? Not needed for v1 — `apply-update.sh`'s "previous release dir"
  rollback (§13.4 step 6) already covers the one-step-back case automatically; anything further
  back would be a manual `install.sh` re-run for now.

## Sources

- https://github.com/atib80/tinyrcon
- https://github.com/mdVisitor/ReCodMod-RCM-Admintool
- https://github.com/Aidoneus/Membrane
- https://github.com/callofduty2x/CoD2x
- https://github.com/bgauduch/call-of-duty-2-docker-server/blob/main/doc/readme.md
- https://wiki.zeroy.com/index.php/Call_of_Duty:_Rcon_Commands
