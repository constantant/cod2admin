# CoD2 Admin — Telegram RCON Bot with Report Automation

Status: draft plan · Owner: kk · Last updated: 2026-09-04

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
4. **Anti-spam**: per-reporter cooldown (e.g. one report per 60s, configurable) and simple
   duplicate-suppression (same reporter+target within a window collapses into one updated
   card rather than spamming the chat) — otherwise a small flood of `!report` spam becomes a
   Telegram-flood vector. The collapse only applies while the existing card is still
   unresolved (no action taken yet, tracked via `reports.resolved_action` — §7); once a card
   has been acted on (kicked/banned/ignored), a new report against the same target posts a
   **fresh** card instead of re-editing a message admins already treated as closed.
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

## Sources

- https://github.com/atib80/tinyrcon
- https://github.com/mdVisitor/ReCodMod-RCM-Admintool
- https://github.com/Aidoneus/Membrane
- https://github.com/callofduty2x/CoD2x
- https://github.com/bgauduch/call-of-duty-2-docker-server/blob/main/doc/readme.md
- https://wiki.zeroy.com/index.php/Call_of_Duty:_Rcon_Commands
