# CoD2 Admin — Working Around the Telegram Block in Russia

Status: **part A implemented (2026-10-04), with free relays instead of a paid VPS** — see §0.
§1–§8 below are the original plan (2026-10-03), kept for its reasoning. Where they conflict
with §0, §0 is what was built. Condensed Russian summary for the server owner:
`docs/PLAN-russia-access-ru.md` — keep the two in sync.

## 0. What was built (2026-10-04)

The owner's constraint: **no extra server and no payment.** That ruled out §2's recommended
A1, a relay on our own VPS, so a second round of research measured the free options from
inside Russia instead.

**Measurements** (2026-10-04, [Globalping](https://globalping.io) probes in 8 Russian hosting
networks: Timeweb, Yandex.Cloud, Selectel ×2, Cloud.ru, Hosting technology, Mediasoft,
Adman/PortTelekom):

| Target | From Russian hosting |
|---|---|
| `api.telegram.org` | **7 of 8 blocked**: the TCP connection never opens. Webhooks don't help either, since the block works both ways. |
| `*.deno.net` (Deno Deploy), `*.workers.dev` (Cloudflare), `*.netlify.app` | 8 of 8 reachable |
| `*.vercel.app` | 4 of 8 blocked, so not used |
| Tor bridges (from reports, not measured) | getting worse: Snowflake partly blocked, obfs4 blocked on some ISPs |

**Design.** A ~70-line relay, `packages/telegram-relay`, runs on free edge platforms. It
forwards only Bot API paths, logs nothing, and has a token-free `/health` check. Two shared
relays are run for the project on free accounts with no card:
`https://cod2admin-telegram-relay.cod2admin.deno.net` and
`https://cod2admin-telegram-relay.cod2admin.workers.dev`. Both were verified from all 8
Russian networks: `/health` was reachable and the relay reached Telegram. A real `getMe`
also worked through each one.

- **Routes in the gateway** (`apps/gateway/src/lib/telegram-routes.ts`): an ordered list, with
  direct access first, then relays. At startup the gateway picks the first route that answers
  `getMe`. Every request uses the current route, via grammy's `buildUrl`.
  - **Failover:** when a request fails with a network error, the gateway checks the route with
    `getMe`. Only if that fails too does it move to the next route; either way it retries once.
    - **Changed 2026-10-07:** it used to switch on any single failed request. A bot on the NAS
      (outside Russia, with working direct access) switched routes 116 times in 3 days on
      network blips. It then polled through a relay until the 30-minute check moved it back, and
      used up the shared relays' free quotas. That bot now runs direct-only (`/relays` setting
      `{"direct":true,"relays":[]}`) until it gets this fix.
  - **Returning to direct:** every 30 minutes it checks whether an earlier route (e.g. direct)
    works again.
- **Managed from Telegram:** `/relays` (owner-only) shows, tests, adds (only after the relay
  actually reaches Telegram), removes and resets routes. Changes are stored in admin-store's new
  `settings` table and take effect immediately. Precedence: `/relays`, then `.env`
  (`TELEGRAM_RELAYS`, `TELEGRAM_DIRECT`), then direct plus the built-in shared relays.
- **Cloudflare's 16 KB cap:** Russian ISPs cut Cloudflare connections after 16 KB. Every Bot
  API request uses a fresh connection (no keep-alive), and `getUpdates` fetches at most 10
  updates at a time. Deno is listed first anyway.
- **Installer:** its token check tries the same routes. A rejected token (exit 2) is asked for
  again. "No route works" (exit 3) offers to enter a relay URL or finish anyway. With
  `--config`, it warns and continues. The final start check then only warns, since the bot
  keeps retrying.
- **Trust:** tokens pass through the relays. The code is open and logs nothing, and anyone can
  deploy their own relay (see `packages/telegram-relay/README.md`) and drop the shared ones with
  `/relays`.

**Still open (B):** admins' own Telegram apps in Russia need a VPN or MTProto proxy. Relays only
carry the bot's traffic. Free public MTProxy lists exist, but they're unreliable.

**Also still open:** `installer/apply-update.sh` sends its "update failed and was rolled back"
alert straight to `api.telegram.org`, not through the relays. On a blocked host the rollback
still works, but that alert never arrives (`PLAN.md` §13.4).

## 1. Problem

Roskomnadzor started slowing down Telegram in February 2026. Since mid-March 2026 the block is
**nearly total**: without a VPN, around 95% of connection attempts from Russia fail. Developers
report that `api.telegram.org` can't be reached from a number of Russian hosting providers, and
the filtering is DPI/packet-level, not a simple IP blocklist. Russian VPNs are being
cracked down on at the same time.

This hits cod2admin in **two separate places**. They need different fixes:

| # | Who is in Russia | What breaks | Where in our code |
|---|---|---|---|
| **A** | The **game server host** (where `install.sh` runs and the gateway lives — §10 of `PLAN.md` requires it to be on the same host as the CoD2 server) | 1. **The install itself:** `wizard_telegram()` → `telegram-check.mjs` calls `https://api.telegram.org/bot<token>/getMe`, times out after 8s, and the wizard loops forever (or calls `die` in `--config` mode). 2. **Runtime:** grammy's long-polling `getUpdates` and every `sendMessage` fail, so the bot is dead even though RCON works fine. | `installer/install.sh` (`telegram-check.mjs`, `wizard_telegram`), `apps/gateway/src/lib/bot.ts` (`new Bot(token)`, no client options) |
| **B** | The **admins/moderators** (people using the Telegram app) | Their Telegram clients can't connect, so they can't send commands or see report cards, even when the gateway itself is fine. | Not our code. This is client-side. |

**A** is a software problem we can fix in the product. **B** is a user-connectivity problem. We can only
help with it (docs and a one-time setup), not solve it in code. Fixing A is required even if
every admin personally uses a VPN, because the *server* also has to reach Telegram.

The author's own NAS dev rig isn't in Russia, so none of this shows up there. It does show up for a real
adopter's Russian-hosted box (e.g. the `185.158.113.146` host mentioned in `PLAN-miniapp.md` §3).

## 2. Options for A (server → Telegram)

The key idea: a Russian host can't talk to Telegram directly, but it *can* talk to a
neutral-looking HTTPS endpoint abroad that talks to Telegram for it. DPI sees a normal TLS
connection whose SNI is our own domain, not Telegram's.

| Option | How | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A1. Bot API relay abroad** (own small VPS, e.g. NL/DE/FI) | Caddy/nginx on the VPS reverse-proxies `https://tg-relay.example.com/bot*` and `/file/bot*` to `https://api.telegram.org`. The gateway sets grammy's `client.apiRoot` to the relay URL. | Plain HTTPS to a domain we control, nothing Telegram-shaped on the Russian side. No VPN client on the game host. Long polling works unchanged. ~€3–5/month VPS. One relay can serve many installs. | The relay sees the bot token (it's in the URL path), so it **must be a box the adopter (or we) controls**, never a public third-party relay. The relay must not log request paths. | **Recommended default** |
| **A1′. Same relay as a Cloudflare Worker** | ~20-line Worker that forwards `/bot*` to `api.telegram.org`. | Free, no VPS, nothing to patch. | Russian ISPs have been throttling Cloudflare-fronted traffic since mid-2025 (connections cut after ~16 KB were reported). Long-poll responses and file downloads can go over that. The token passes through a third party's runtime. | Documented fallback only, after a live test from a Russian host (§6) |
| **A2. Generic outbound proxy** (`TELEGRAM_PROXY_URL`, `http(s)://` or `socks5://`) | grammy's `client.baseFetchConfig.agent` gets an `HttpsProxyAgent`/`SocksProxyAgent`. On Node, grammy 1.46 uses `node-fetch@2`, which accepts `agent`. | Covers adopters who already run their own tunnel (e.g. an Xray/VLESS-Reality or AmneziaWG client on the host that exposes `socks5://127.0.0.1:1080`). These protocols currently survive DPI better than a plain proxy. No new infra from us. | A plain HTTP/SOCKS proxy *to a foreign IP* is itself DPI-detectable and gets blocked. This only works when the adopter's tunnel is obfuscated. We don't control or support their tunnel. | **Implement alongside A1.** Cheap, and it's the escape hatch when A1 gets blocked too |
| A3. Move the gateway abroad | Run the gateway on a foreign VPS and talk RCON over the internet. | No code changes for Telegram. | Breaks the `PLAN.md` §10 same-host decision: `log-tailer` needs local `games_mp.log`, so **report automation dies**. Also sends the RCON password in cleartext UDP across borders. | Rejected |
| A4. Local `telegram-bot-api` server | Self-hosted Bot API server on the game host. | — | It still has to reach Telegram's DCs over MTProto, which is the very thing that's blocked. Doesn't solve anything by itself. | Rejected |
| A5. Switch to webhooks | Telegram pushes updates to us. | — | Needs inbound connections from Telegram IPs *into* Russia (also filtered), plus HTTPS on the game host. Outbound `sendMessage` is still blocked. | Rejected (long polling stays, as `PLAN.md` §10 already decided) |

**Decision proposed:** ship **A1 + A2** as two optional, independent config knobs. Use whichever
the adopter has. If both are set, the proxy applies to requests going to the relay. Default
(neither set) stays exactly today's behaviour, so non-Russian installs don't change at all.

### 2.1 Relay hardening (A1)

- Path allowlist: only `^/bot[0-9]+:[A-Za-z0-9_-]+/` and `^/file/bot...`. Everything else gets 404.
  The relay is not an open proxy.
- **No access logs**, or logs with the path stripped, since the token is in the path.
- Optional shared header (`X-Relay-Key`) checked by the relay, so a leaked relay hostname alone
  isn't usable. grammy can send it via `baseFetchConfig.headers`.
- Pick a boring hostname (not `telegram-proxy.*`). Keep the cert valid via Caddy's automatic
  ACME.
- One relay can serve several installs (tokens are per-bot anyway). We can offer to run one
  for adopters we trust, but the docs default is "run your own".

## 3. Code changes (A)

### 3.1 Gateway config (`apps/gateway/src/lib/config.ts`)

Two new **optional** env vars, following the same "gracefully off" pattern as `COD2_LOG_PATH` /
`UPDATE_STAGING_DIR`:

- `TELEGRAM_API_ROOT`: e.g. `https://tg-relay.example.com`. Default `https://api.telegram.org`.
  Validate that it's an `https://` URL with no trailing path.
- `TELEGRAM_PROXY_URL`: `http://`, `https://`, `socks5://` or `socks5h://`. Validate the scheme.
  `socks5h` matters: it keeps DNS resolution for `api.telegram.org` off the Russian resolver.
- (optional) `TELEGRAM_RELAY_KEY`: sent as the `X-Relay-Key` header when set.

Unit tests in `config.spec.ts`: valid/invalid schemes, defaults when unset.

### 3.2 Bot construction (`apps/gateway/src/lib/bot.ts`)

```ts
new Bot(config.telegramBotToken, {
  client: {
    apiRoot: config.telegram.apiRoot,                // undefined → grammy default
    baseFetchConfig: {
      agent: config.telegram.proxyUrl ? makeAgent(config.telegram.proxyUrl) : undefined,
      headers: config.telegram.relayKey ? { 'X-Relay-Key': config.telegram.relayKey } : undefined,
    },
  },
});
```

`makeAgent` goes in a new `lib/telegram-transport.ts`. It picks `https-proxy-agent` or
`socks-proxy-agent` (new deps, vendored by `build-installer-bundle.sh` like the others). Check that
grammy merges `baseFetchConfig` and doesn't override the `agent` it might set itself. Check
`node_modules/grammy/out/core/client.js` before you rely on this.

### 3.3 Startup resilience (`apps/gateway/src/main.ts`)

Today, if Telegram can't be reached, `bot.start()` keeps retrying quietly and nobody notices. Add:

- Log a clear warning when `getMe`/`getUpdates` fails with a network error (not a 401), naming
  the fix: "Telegram API unreachable from this host — set TELEGRAM_API_ROOT or TELEGRAM_PROXY_URL,
  see docs/PLAN-russia-access.md".
- Keep RCON-side work (expiry poller, report tailers) running while Telegram is down. Report
  cards just queue or drop. This is mostly true already. Verify it, especially `checkPendingUpdateOnBoot`,
  which `await`s a Telegram send before `bot.start()` and must not hang boot forever.

### 3.4 Installer (`installer/install.sh`) — "while the system gets installed"

This is the part that blocks installs today.

1. `telegram-check.mjs` takes `apiRoot`, `proxyUrl` and `relayKey` arguments. It must tell
   **network failure** (timeout/ECONNRESET/TLS reset → probably a block) apart from **token rejected**
   (HTTP 401 → wrong token). Today both just print "failed".
   - Proxy support in the check script: Node 20's built-in `fetch` doesn't accept `agent`.
     Either use `undici`'s `ProxyAgent` (as `dispatcher`) from the vendored bundle, or run the
     check through the same `telegram-transport.ts` code the gateway uses (preferred: one code
     path, so "the installer check passed" means the gateway will connect too).
2. In `wizard_telegram()`, on a **network** failure, don't loop asking for the token again.
   Show a menu instead:
   ```
   Can't reach api.telegram.org from this server (Telegram is blocked in some countries).
     1) Use a Bot API relay URL       (recommended - see installer/README.md "Telegram blocked?")
     2) Use a proxy (http/socks5)     (if this host already runs a VPN/proxy client)
     3) Retry direct connection
     4) Skip the check and finish installing anyway (bot won't work until fixed)
   ```
   Re-validate through whatever they chose, then print `Connected as @bot via <route>`.
   Option 4 writes the config and starts the service, so RCON/Postgres/update setup isn't lost.
   The admin can add the relay later with `install.sh --config` (or by editing `.env` and
   restarting).
3. `--config` mode: read `TELEGRAM_API_ROOT` / `TELEGRAM_PROXY_URL` / `TELEGRAM_RELAY_KEY` from
   the config file. A network failure there gives a clear error naming those keys, not just
   "Telegram rejected TELEGRAM_BOT_TOKEN" (which is wrong: Telegram never saw it).
4. `write_env()` writes the new keys when set. `apply-update.sh` / `/update` keep `.env`
   unchanged, as they already do.

### 3.5 Other outbound traffic from a Russian host (check, don't assume)

- **GitHub** (`api.github.com`, release asset downloads from `objects.githubusercontent.com`):
  used by the install one-liner, the version-check poller and `/update`. Currently reachable from
  Russia, but GitHub has been briefly blocked there before. `github-releases.ts` should respect the same
  `TELEGRAM_PROXY_URL` (rename the concept to an `OUTBOUND_PROXY_URL`, or keep a separate
  `GITHUB_PROXY_URL`; decide during implementation). Low priority.
- **`deb.nodesource.com`**: only used when Node is missing at install time. If it fails, the
  installer should say "install Node ≥20 from your distro/mirror and re-run" instead of failing
  with a raw curl error.

## 4. B: the admins' own Telegram access

There's nothing to change in code here, but the product should make it easy:

- **MTProto proxy with fake-TLS** (e.g. `mtg` or the official MTProxy) on the **same foreign VPS**
  as the A1 relay. One €3–5 box covers both: the server's Bot API access and the admins'
  Telegram access. Telegram clients support it natively (Settings → Data → Proxy, or a
  `tg://proxy?...` link). No separate VPN app, and other traffic isn't affected.
- Ship a `docker/relay/` example: a `docker-compose.yml` with **Caddy (Bot API relay)** + **mtg
  (MTProto)**, and a short README. Fill in a domain and run `docker compose up -d`. It prints the
  `tg://proxy` link to send to admins. This is the "well-working solution" an adopter actually runs.
- Docs note: fake-TLS MTProto proxies are also being hunted. Rotating the secret or port is a
  one-command restart of that container.

## 5. Plan C: if Telegram is completely unusable

A1/A2/B depend on *some* encrypted path abroad staying open. If that stops working (e.g. strict
mobile whitelists), the system can't be managed at all, since all control is in Telegram.
Escalating fallbacks, **not part of this plan's first delivery**, listed so the architecture stays open
to them:

1. **Standalone web panel**: the Angular app from `PLAN-miniapp.md` can also run in a normal
   browser, served from the game host over HTTPS (Caddy/nip.io, already planned there). It needs a
   non-Telegram login (e.g. a one-time code generated by `install.sh`/CLI, then passkey/TOTP per
   admin). This is the most robust fallback, because it depends only on the game host being reachable,
   and it reuses the Mini App work almost entirely. **Proposed as the real Plan C.**
2. **MAX messenger bot adapter**: `BotContext` is already grammy-agnostic by design
   (`bot.ts`), so a second chat transport is architecturally possible. But MAX's bot platform
   availability for individuals, its API stability, and the privacy implications are
   **open questions** (§7). Its adoption is also weak (users moved to other messengers instead).
   Don't build it speculatively.

## 6. Testing

The dev rig isn't in Russia, so the block has to be **simulated**:

- **Unit:** `config.spec.ts` (new vars), `telegram-transport.spec.ts` (agent selection, header
  injection), installer check script failure classification (network vs 401).
- **Simulated block (docker):** a throwaway `debian:12` container where `api.telegram.org` is
  black-holed (`--add-host api.telegram.org:127.0.0.9` plus an `iptables` REJECT on Telegram's
  published IP ranges, `149.154.160.0/20` and `91.108.4.0/22` etc.). Then confirm that:
  1. the current release's `install.sh` hangs/loops (reproduces the bug),
  2. the new installer shows the menu on a network failure, and option 1 with a real relay
     connects and the gateway answers `/status`,
  3. option 4 finishes the install and the bot comes up once `.env` gets a relay,
  4. `TELEGRAM_PROXY_URL=socks5h://...` works through a local `ssh -D` or a dante container.
- **Real-world check (required before calling this done):** run `telegram-check.mjs` through
  the relay **from an actual Russian host** (the adopter's box, or a cheap RU VPS for a day).
  Run it from at least one mobile-network vantage point for the MTProto proxy. Simulation can't
  reproduce DPI behaviour. Same goes for the Cloudflare Worker variant (A1′) before documenting it.
- **Relay:** check the path allowlist (`/` → 404, `/bot<tok>/getMe` → 200) and that no token
  shows up in the relay's logs.

## 7. Open questions for the user

1. **Who runs the relay?** Each adopter runs their own (docs + `docker/relay/` example), or you
   run one shared relay for the adopters you know (simpler for them, but you'd see their bot tokens
   in transit)? Proposed: own-relay by default, shared as an opt-in favour.
2. **Is a foreign VPS acceptable for the Russian adopter(s)** (payment from Russia can be
   awkward), or should A2 via their existing VPN client be the primary route for them?
3. **Plan C priority:** should the standalone web panel (§5.1) move ahead of other Mini App
   phases, given Telegram's future in Russia?
4. **Rollout:** ship as a minor release (`feat(gateway)` + `feat(installer)`), and does the
   existing Russian install need a hand-held `install.sh --config` re-run, or will a relay-only
   `.env` edit + restart do?

## 8. Phased delivery

| Phase | Scope | Unblocks |
|---|---|---|
| **R1** | Config vars + `telegram-transport.ts` + `bot.ts` wiring + startup warning (§3.1–3.3) | The gateway works in Russia given a relay or proxy (set by hand in `.env`) |
| **R2** | Installer: failure classification, the route menu, `--config` keys, skip-and-finish (§3.4) | **Installs on Russian hosts complete** |
| **R3** | `docker/relay/` (Caddy relay + mtg) + `installer/README.md` "Telegram blocked?" section + `PLAN-ru.md`/README pointers (§2.1, §4) | Adopters can set up the relay and admin proxy themselves |
| **R4** | Real Russian-host verification (§6), then GitHub/Nodesource fallbacks (§3.5) | Confidence it works for real, not just in simulation |
| R5 (later) | Plan C: standalone web panel, shared with the Mini App plan | Management survives a total Telegram loss |

R1+R2 are small (one new module, two config fields, one installer function rewrite) and can ship in
one release. R3 is docs and compose only.

## Sources

- [Blocking of Telegram in Russia (Wikipedia)](https://en.wikipedia.org/wiki/Blocking_of_Telegram_in_Russia)
- [OSW: Russia blocks Telegram and cracks down on VPNs (2026-04-17)](https://www.osw.waw.pl/en/publikacje/analyses/2026-04-17/russia-blocks-telegram-and-cracks-down-vpns)
- [The Moscow Times: Telegram outages reported across Russia (2026-03-16)](https://www.themoscowtimes.com/2026/03/16/telegram-outages-reported-across-russia-as-block-rumors-swirl-a92233)
- [Telegram in Russia 2026: what's going on](https://russiable.com/telegram-russia/)
- [Telegram vs MAX for bots in 2026 (relay abroad, webhook/monitoring advice)](https://incube.ai/en/blog/telegram-vs-max-business-chatbot)
- [Telegram.Bot docs: proxies (MTProto proxies don't work for the Bot API)](https://telegrambots.github.io/book/4/proxy.html)
