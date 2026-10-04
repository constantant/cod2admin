# telegram-relay

A tiny Telegram Bot API relay for cod2admin bots whose server can't reach `api.telegram.org` —
in practice, servers in Russia, where Telegram has been blocked since March 2026. See
[`docs/PLAN-russia-access.md`](../../docs/PLAN-russia-access.md) for the background and the
measurements behind this design.

The bot sends its normal Bot API requests to a relay, and the relay forwards them to Telegram.
Relays run for free on edge platforms that Russian hosting networks can still reach. No server or
payment is needed.

- **What it forwards:** only Bot API paths (`/bot<token>/<method>`, `/file/bot<token>/...`).
  Anything else gets `404`, so it can't be used as an open proxy.
- **Logging:** none. Every request path contains the bot's token, so whoever runs a relay
  could see it. Only use relays run by you or someone you trust.
- **`GET /health`:** answers `{"ok":true,...}` when the relay can reach Telegram. It needs no
  token, so it's safe to use for monitoring.

The handler (`src/lib/relay.ts`) uses only web-standard `Request`/`Response`/`fetch`. The same
code runs on every platform, and `deploy/` has a two-line entry file for each one.

## Shared relays

These are run for the project and built into the bot (`DEFAULT_TELEGRAM_RELAYS` in
`apps/gateway/src/lib/telegram-routes.ts`, mirrored in `installer/install.sh`):

| Platform | URL |
|---|---|
| Deno Deploy | `https://cod2admin-telegram-relay.cod2admin.deno.net` |
| Cloudflare Workers | `https://cod2admin-telegram-relay.cod2admin.workers.dev` |

Measured on 2026-10-04 from 8 Russian hosting networks (Timeweb, Yandex.Cloud, Selectel,
Cloud.ru and others) using [Globalping](https://globalping.io):

| Target | Result |
|---|---|
| `api.telegram.org` | 7 of 8 blocked (the TCP connection never opens) |
| Both relays' `/health` | 8 of 8 reachable, and the relays reached Telegram |

Deno is listed first because Russian ISPs have cut connections to Cloudflare after 16 KB
since 2025. The bot works around that (a fresh connection per request, small update batches),
but Deno avoids the problem entirely.

The bot's owner can change the relay list from Telegram with `/relays`, including removing
the shared relays.

## Deploying your own

Free, and about five minutes per platform. Deploy at least two, so the bot can fail over.

**Deno Deploy** ([console.deno.com](https://console.deno.com), sign in with GitHub). Create an
access token under Account Settings → Access Tokens, then run from a folder *outside* this
repository. The Deno CLI rewrites a nearby `package.json`/`pnpm-workspace.yaml` if it finds
one. Use a folder holding a copy of `src/lib/relay.ts` and `deploy/deno.ts`:

```sh
DENO_DEPLOY_TOKEN=ddp_... deno deploy create . --json --non-interactive \
  --org <your-org> --app my-telegram-relay --source local --runtime-mode dynamic \
  --entrypoint deploy/deno.ts --do-not-use-detected-build-config --region eu
```

**Cloudflare Workers** ([dash.cloudflare.com](https://dash.cloudflare.com/sign-up)). From this
package's folder:

```sh
pnpm dlx wrangler login     # approve in the browser
pnpm dlx wrangler deploy    # uses wrangler.toml; prints the *.workers.dev URL
```

Then check it with `curl https://<your-relay>/health`, and add it in Telegram with
`/relays add https://<your-relay>`. To use it from the start of an install instead, put
`TELEGRAM_RELAYS=https://<your-relay>` in the installer's config file.
