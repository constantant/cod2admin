# CoD2 Admin — Telegram Mini App Server Manager

Status: draft plan · Owner: kk · Last updated: 2026-09-08

## 1. Goal

A Telegram **Mini App** (the in-Telegram web surface, opened via a button/menu item, not a
separate bot) that gives admins a classic, full-screen "server manager" UI instead of chat
commands — built with **Angular** + **Angular Material 3**. It sits *alongside* the existing
chat-command bot from `docs/PLAN.md`, not instead of it: both talk to the same `apps/gateway`
process and the same Postgres data (`admin-store`, `ban-store`), so an action taken from either
surface is consistent and shows up in the same audit log.

Scope for v1:

1. Full RCON management (status, players, kick/ban/unban/tempban, map control) with a real UI
   instead of one command per action.
2. Live in-game chat: watch the chat feed and post into it, without alt-tabbing to a console.
3. Ban data management: players and IPs, temp vs permanent, expiry, reasons — browse/search/
   edit, not just add-by-command.
4. See §6 for additional features worth adding while we're building a real UI anyway.

## 2. Relationship to `docs/PLAN.md`

This is a companion plan, not a replacement. Reused as-is:

- `packages/rcon-client` — same RCON connections, same rate-limiting/backoff.
- `packages/admin-store` / `packages/ban-store` — same roles, same ban records, same audit log
  table (Mini App actions get their own `source` tag in the audit log — see §7).
- `packages/log-tailer` — already tails `games_mp.log` for the `!report` trigger (PLAN.md §5);
  the Mini App's live chat view (§6.2) is a second consumer of the same parsed event stream,
  not a second log-tailing implementation.
- `apps/gateway` — per the hosting-placement decision below (§3.1), the Mini App's backend is
  a module *inside* this same process, not a new deployable.

One deliberate deviation from `docs/PLAN.md` §10: that plan resolved "no public HTTPS endpoint
needed" specifically because the chat bot uses Telegram long-polling. A Mini App **cannot** work
that way — Telegram loads it as a web page and requires the URL to be **HTTPS with a
publicly-trusted certificate** (self-signed doesn't work, and there's no polling equivalent for
serving a web page). §3 works through what that costs and the options for paying it. This
exposure is scoped to the Mini App's HTTP(S) surface only — it does not change anything about how
RCON talks to the game server (still local/UDP, still not internet-facing).

**Important framing for §3**: like the rest of `apps/gateway`, this is distributed, installed
software (`docs/PLAN.md` §12–§13's `install.sh`/self-update model) — there is no single
"production" box kk controls or deploys to. Any real deployment is a third-party CoD2 server
owner running the installer on *their own* rented game-hosting box, which kk typically has no
access to (e.g. `185.158.113.146` is one such prospective adopter's server, used here only as a
concrete example, not a target kk deploys to). The user's own QNAP NAS is a permanent test/dev
rig for this project and is never itself a real deployment — its home-NAT networking is *not*
representative of what a typical adopter's box looks like, and shouldn't be optimized for as if it
were.

## 3. Hosting & HTTPS — feasibility and options

**Feasibility: yes.** A Telegram Mini App is a web page rendered inside Telegram's own WebView.
Requirements imposed by Telegram, not by us:

- The app's URL must be HTTPS with a certificate a normal browser trust store accepts.
- The exact URL is registered with **@BotFather** (`/newapp`, or attached to the bot's menu
  button / an attachment-menu entry).
- Auth is **not** a login screen: Telegram injects a signed `initData` string (HMAC-SHA256 over
  the user's Telegram identity, keyed with the bot token) into the page at launch. The backend
  validates that signature server-side on every request and maps the resulting Telegram user ID
  onto the existing `admin-store` role (§8) — nobody without an existing admin/moderator role in
  `admin-store` gets a functioning session, regardless of what the Mini App UI shows them.

**Since this is per-adopter, self-installed software, the hosting story needs to work as a
generic installer step, not a one-off choice made once.** The good news: `docs/PLAN.md` §10
already requires gateway to be co-located with the game server it manages, and a CoD2 dedicated
server is only useful to players if its host has a **public IP** — that's the normal case for
any rented/self-hosted game server. RCON and game traffic share a single UDP port (`28960`,
PLAN.md §11.1), so on a real deployment (unlike PLAN.md §11.1's dev setup, which binds it to
`127.0.0.1` only) that port is necessarily reachable from the internet the moment players can
connect — the same source-IP firewalling PLAN.md §2.4/§8 recommends for RCON specifically doesn't
change the fact that the *host itself* already has a public IP. So the typical adopter is in the
*easy* case for Mini App hosting: their box is already publicly reachable, no NAT/port-forwarding
problem to solve.
The NAS's home-NAT situation is the atypical case — true for kk's personal test rig, not for a
real adopter's rented box.

| Adopter's situation | Option | How it works | Pros | Cons |
|---|---|---|---|---|
| **Typical: box has a public IP** (the normal case, e.g. an adopter like the one at `185.158.113.146`) | **Direct HTTPS via Caddy** (or nginx+certbot), installer-managed | `install.sh` runs Caddy (or configures the adopter's existing reverse proxy) with automatic Let's Encrypt, reverse-proxying to the gateway's `miniapp/` HTTP port. Needs a hostname — either a domain the adopter already owns, or a **free wildcard DNS** service (e.g. `nip.io`/`sslip.io`, which resolves `185-158-113-146.nip.io` straight to that IP with zero setup) so no domain purchase is required. | Simplest path, no third-party tunnel account, matches the project's existing "no config-file editing" self-service philosophy (PLAN.md §1) — this can be a fully automated installer step. | The origin IP is directly exposed on port 443 too (already true for the game/RCON ports on every real deployment). |
| Same, optional hardening | **Cloudflare DNS, proxied ("orange cloud")** | Same as above, but the adopter's domain is proxied through Cloudflare instead of pointing at the IP directly. | Free; hides the origin IP for the *web* surface, adds WAF/DDoS absorption for HTTP(S)/WS traffic. | Requires the adopter to have a domain in a Cloudflare account (not compatible with the zero-domain nip.io fallback); doesn't protect the game/RCON UDP ports either way. |
| **Atypical: box has no public IP** (home NAT — e.g. kk's own NAS test rig, or an adopter self-hosting the same way) | **Cloudflare Tunnel** (`cloudflared`) — **manual/doc-only, decided (§10)** | Sidecar process/container, outbound-only connection to Cloudflare's edge — no inbound port ever opens on the router. Documented as a manual setup path (e.g. in `installer/README.md`), not automated by `install.sh` itself. | No port-forwarding/DDNS; free; automatic cert; proxies WebSocket cleanly (§6.2). This is how kk's own NAS rig should get HTTPS for dev/testing (§11), since it *is* NAT'd. | Extra third-party dependency; minority case, so `install.sh` doesn't build a guided flow for it — the adopter follows the doc themselves. |
| Either case, dev-only | **ngrok / Cloudflare quick tunnel** | Temporary public URL for testing against a real Telegram client. | Zero setup. | URL rotates on free tier — not viable as the stable URL registered with BotFather. Fine for §11's dev loop only. |

**Decided (§10):** the installer defaults to direct HTTPS via Caddy, using the adopter's own
domain if they supply one and falling back automatically to a free wildcard-DNS hostname
(nip.io/sslip.io) if not — zero manual DNS/cert work for the typical "public-IP game server"
adopter, the same self-service bar the rest of the project already holds itself to. Cloudflare
Tunnel stays a documented manual path for the NAT'd minority case, not an `install.sh`-automated
choice — that case is rare enough among real adopters that a guided installer flow for it isn't
worth building. None of this has to land before starting Phase M1 (§9): the Angular app and the
gateway's new HTTP module can be built and tested locally first (§11), with the installer's HTTPS
step as an independent, later track.

### 3.1 Where the backend lives (decided)

The Mini App's REST/WebSocket API is a **module inside `apps/gateway`**, not a separate app —
same rationale `docs/PLAN.md` §2.1 already used for the chat bot itself ("the gateway process
holds the rcon secret, clients are thin"): the process already owns the RCON connections, the
Postgres pool, and the `log-tailer` event stream, so a second process would either duplicate all
three or add an internal RPC hop for no benefit. Concretely: `apps/gateway/src/miniapp/` adds an
HTTP server (routes below) and a WebSocket endpoint for live chat/status push, run alongside the
existing grammy long-polling loop in the same Node process.

## 4. Architecture

```
┌────────────────────┐                          ┌──────────────────────────────────┐
│  CoD2 Dedicated      │  games_mp.log tail /     │        Admin Gateway service      │
│  Server(s)            │◀───── RCON UDP ────────▶│        (apps/gateway, Node.js)    │
└────────────────────┘                          │  ┌────────────────────────────┐  │
                                                  │  │ rcon-client / log-tailer /  │  │
                                                  │  │ report-pipeline / ban-store /│  │
                                                  │  │ admin-store                 │  │
                                                  │  └────────────────────────────┘  │
                                                  │           │              │        │
                                                  │  Telegram Bot API   miniapp/*     │
                                                  │  (long-polling,     (HTTP + WS,    │
                                                  │   existing)          new)          │
                                                  └───────────┼──────────────┼────────┘
                                                              │              │
                                                  Telegram group/channel   TLS-terminating
                                                  (existing chat bot UI)   tunnel/proxy (§3)
                                                                             │
                                                                    Telegram Mini App
                                                                    (Angular + Material 3,
                                                                     opened from bot menu button)
```

Both surfaces (chat bot, Mini App) are thin clients over the same in-process gateway logic and
the same `admin-store`/`ban-store` tables — an action from one is immediately visible from the
other, and both write to the same audit log (tagged by `source`, §8).

## 5. Tech stack

- **Frontend**: Angular (standalone components, current LTS) + **Angular Material 3** (the
  MDC-based Material you get from `ng add @angular/material` today, themed via M3's
  `mat.theme()` API). New Nx app, generated the normal way (`nx-generate` skill,
  `@nx/angular:application`) as `apps/miniapp-web` when Phase M1 starts.
- **Telegram Mini App SDK**: official `telegram-web-app.js` (or the community
  `@telegram-apps/sdk` wrapper around it) for `initData`, theme params (`theme_changed` →
  drives Angular Material's light/dark M3 tokens), `MainButton`/`BackButton`, haptic feedback,
  and viewport events. Loaded once at app bootstrap.
- **Backend**: a small HTTP framework (Fastify or Express — pick whichever has less friction
  alongside grammy's own HTTP client usage; not yet decided, doesn't block planning) plus `ws`
  for the WebSocket endpoint, both mounted inside `apps/gateway` (§3.1).
- **Auth**: no session/password. Every request carries the raw Telegram `initData` (per
  Telegram's own recommended `Authorization: tma <initData>` pattern); a gateway middleware
  validates the HMAC signature and freshness (reject stale `auth_date`), then looks up the
  Telegram user ID in `admin-store` for a role — same roles as the chat bot (§8).
- **Real-time transport**: WebSocket, for two things — pushing new chat lines as `log-tailer`
  parses them (§6.2), and pushing live player-count/status changes to an open dashboard (§6.4)
  without polling. Cloudflare Tunnel and Caddy both proxy WebSocket natively, so this doesn't
  narrow the §3 hosting choice.

## 6. Features

### 6.1 Full RCON management

- Live status/players table (reuses `rcon-client#status()`), sortable, with ping/score/team
  where the game exposes them.
- One-tap kick / ban / unban / tempban per player row, reusing the exact same gateway logic the
  chat bot's inline buttons already call (PLAN.md §5, §6) — same GUID-0/IP-fallback handling
  (PLAN.md §2.4, §5.6), same in-game broadcast on action (PLAN.md §5 step 6).
- Map control: current map display, map list, one-tap map change.
- Raw RCON console (owner-role only) for anything not covered by a dedicated control — same
  trust boundary as `/rcon` in the chat bot.

### 6.2 In-game chat

- Live chat view fed by the same `log-tailer` parser already tailing `games_mp.log` for
  `!report` (PLAN.md §5.3) — the Mini App becomes a second subscriber to that event stream, not
  a second log-tailing implementation (§2). On open, backfill the last N lines by reading the
  tail of the current log file; live lines arrive over the WebSocket after that.
  Note the empty-`name`-on-first-lines quirk already documented in PLAN.md §2.4 — the UI must
  handle a chat line with no name yet, same as the report pipeline does.
- Posting: admin types a message in the Mini App → gateway sends it via the existing `say()`
  wrapper (broadcast) for public messages. Per-player whisper (`tell`) has no dedicated wrapper
  in `rcon-client` today (only `getInfo/getStatus/status/kick/banClient/banUser/unbanUser/say/
  map/getMapRotation` are implemented) — it would go through the raw `rcon()` passthrough, or a
  small `tell()` wrapper added alongside it. No new *game-side* integration needed either way,
  just a small `rcon-client` addition.

### 6.3 Ban data management

- Browse/search bans and IP bans (`ban-store`) by name, GUID, or IP — not just add-by-command.
- Edit reason/expiry on an existing ban, manually clear an expiry, bulk-unban.
- Surfaces the GUID-0/IP-ban distinction from PLAN.md §2.4/§5.6/§7 explicitly in the UI (e.g. a
  visible "IP ban (no GUID)" badge) rather than leaving it implicit the way chat-command output
  does.

### 6.4 Suggested additions (not asked for, worth considering for later phases)

- **Server dashboard**: current map, uptime, player-count history — needs a lightweight
  snapshot table (a new small table, e.g. `server_snapshots(server_id, ts, player_count, map)`,
  populated by the existing self-poll interval PLAN.md §3/§5.7 already runs for IP-ban expiry —
  same poll, one more thing recorded).
- **Report queue view**: the `!report` cards report-pipeline already assembles (PLAN.md §5) are
  currently Telegram-message-only, and — checked against the real schema — **nothing persists
  them today**: PLAN.md §7 only sketches a `reports` table, and no `packages/*/src/lib/schema.ts`
  actually defines one. A Mini App report queue therefore needs a real `reports` table built and
  wired into `report-pipeline`'s write path first, not just a read-only UI over existing data.
- **Audit log viewer**: `admin-store`'s audit log already exists (PLAN.md §7) but is only
  queryable via `/auditlog` in chat — a searchable/filterable table view (by admin, action type,
  date range, server) is a natural Mini App feature with zero new backend data model.
- **Admin & role management UI**: visual equivalent of `/addadmin`/`/setrole`/`/listadmins`, plus
  a multi-server switcher (tab per server bound via `/bindserver`) instead of one bot chat per
  server.
- **Player watchlist / moderator notes**: free-text notes attached to a GUID/IP/name, separate
  from bans — for tracking a suspicious player before there's enough to ban them. New small
  table, no game-side integration.
- **Quick-action presets**: saved common kick/ban reasons and tempban durations as one-tap
  buttons instead of retyping.
- **Push-style alerts while the app is open**: use Telegram's `HapticFeedback`/`MainButton` for
  in-app signals (e.g. a haptic buzz when a new `!report` arrives) — the existing Telegram
  message notification still covers the closed-app case.

None of §6.4 blocks v1 (§6.1–§6.3) — listed here so hosting/auth/data-model decisions in this
doc account for them if you want to fold any in early.

## 7. Data model additions

Everything in §6.1–§6.3 needs **no new tables** — it's a UI over `rcon-client`, `admin-store`,
`ban-store`, and `log-tailer`'s existing event stream. The audit log already has a `source`
column (`packages/admin-store/src/lib/schema.ts`'s `auditSourceEnum`, currently
`telegram_button` / `telegram_command` / `auto`) — adding Mini App actions needs a migration
adding a `miniapp` value to that existing enum, not a new column.

New tables only needed for §6.4 items, and only if/when those are built: `server_snapshots`
(dashboard history), a `reports` table (report queue view — see §6.4, not yet built despite being
sketched in PLAN.md §7), and a `player_notes`/watchlist table. None are needed for v1.

## 8. Security notes

- **Auth boundary**: `initData` HMAC validation (§5) is the *only* gate — no separate
  username/password, no long-lived tokens to leak. Reject any request with a missing/invalid/
  stale (`auth_date` too old) signature before it reaches any handler.
- **Authorization**: same roles as the chat bot (`admin-store` — owner/admin/moderator,
  PLAN.md §4) — a Telegram user with no role in `admin-store` gets a valid-looking but
  empty/read-only Mini App, never elevated access through a different code path.
- **Exposure surface**: only the Mini App's HTTP(S)/WS port is internet-facing, via whichever
  tunnel/proxy §3 lands on. RCON stays UDP/local-only exactly as in `docs/PLAN.md` §8 — the Mini
  App backend talks to `rcon-client` in-process, never proxies raw RCON traffic to the browser.
- **Rate limiting**: the Mini App gives admins a much lower-friction way to fire RCON commands
  than typing chat commands — reuse/extend the same outgoing-packet rate limiter `rcon-client`
  already has (PLAN.md §3.1) so a UI double-tap or a buggy client can't flood the game server.

## 9. Phased delivery plan

**Scope (decided, §10): Phases M1–M4 target a single server**, matching how the chat bot itself
started single-admin/single-server (PLAN.md Phase 1) before multi-server landed later (PLAN.md
Phase 2). The multi-server switcher is a Phase M5 item, not built in from the start.

- **Phase M1 — foundations**: `apps/miniapp-web` skeleton (Angular + Material 3 shell, theme
  wired to Telegram's `theme_changed`), `apps/gateway/src/miniapp/` HTTP module with `initData`
  validation middleware and a single read-only `GET /status` route (single server, hardcoded/
  env-selected — no server switcher yet). Goal: prove the Telegram-launch → auth → real gateway
  data round-trip end to end, before building out features.
- **Phase M2 — RCON management UI** (§6.1): player table, kick/ban/unban/tempban, map control,
  owner-only raw console. Still single-server.
- **Phase M3 — live chat** (§6.2): WebSocket push from `log-tailer`, chat view + say/tell.
- **Phase M4 — ban management UI** (§6.3): browse/search/edit bans and IP bans.
- **Phase M5 — nice-to-haves** (§6.4): multi-server switcher (tab per server bound via
  `/bindserver`, matching the chat bot's existing multi-server support) plus pick from dashboard,
  report queue view, audit log viewer, role management UI, watchlist, quick-action presets —
  independently orderable, none blocks the others.
- **Ops — installer HTTPS step** (§3): add the Caddy + domain/nip.io automation to `install.sh`
  (mirroring how PLAN.md §13's self-update tooling was added as an independent installer track),
  plus a Cloudflare Tunnel setup on kk's own NAS test rig for dev/testing (§11). Independent
  track; can happen any time after M1 has something worth exposing, doesn't block M2–M5
  development (which can proceed against a local `ng serve` + a temporary dev tunnel, §11).

## 10. Open questions for the user

- ~~Installer HTTPS step~~ — **resolved (§3)**: `install.sh` defaults to fully automated Caddy +
  nip.io/sslip.io (zero domain, zero manual DNS) when the adopter doesn't supply their own domain,
  rather than always prompting. Cloudflare Tunnel stays a manual/doc-only path for NAT'd installs
  — not an `install.sh`-automated choice.
- ~~Single-server vs multi-server Mini App scope~~ — **resolved (§9)**: Phases M1–M4 target a
  single server; the multi-server switcher is a Phase M5 item, not built in from the start.
- **kk's own dev/test hosting** — the NAS test rig is NAT'd, so it needs Cloudflare Tunnel (or
  similar) regardless of what the installer defaults to for real adopters (§11). Not blocking,
  just worth setting up once Phase M1 has something to expose.

All decision-shaped open questions are resolved — remaining work is implementation, starting
with Phase M1 (§9).

## 11. Testing & dev environment

- **Non-Telegram dev loop**: `nx serve miniapp-web` against a local gateway with `initData`
  validation stubbed/bypassed behind a dev-only flag — fastest loop for UI work, but doesn't
  exercise real Telegram auth or the WebView environment's quirks.
- **Real-device dev loop**: BotFather's Mini App URL can point at a temporary tunnel (ngrok or a
  Cloudflare quick tunnel, §3's table) during development. Since kk's own NAS test rig is NAT'd
  (§3), a standing Cloudflare Tunnel there is worth setting up once Phase M1 has something to
  expose — this is kk's dev/test hosting, not a stand-in for how a real adopter's installer-driven
  setup (§3, §9) will work.
- Everything in `docs/PLAN.md` §11 (local CoD2 server + Postgres via docker-compose) is reused
  unchanged — the Mini App backend is a module in the same `apps/gateway` process that stack
  already runs.
