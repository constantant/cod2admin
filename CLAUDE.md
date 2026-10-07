<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

# Project-specific instructions

## Package manager

This workspace uses **pnpm** (see `packageManager` in `package.json`, `pnpm-workspace.yaml`,
`pnpm-lock.yaml`) — not npm. Always run nx through pnpm: `pnpm exec nx ...` (or `pnpm nx ...`).
Do not use `npm install`/`npm ci`/`npx nx` here — this workspace hit a reproducible npm 10.x
arborist bug (`Cannot read properties of null (reading 'edgesOut')`) on install, which is why it
migrated off npm.

- If a bare `pnpm` command isn't on `PATH`, use `corepack pnpm ...` instead of installing pnpm
  globally — Node ships Corepack, and it resolves the exact version pinned in `packageManager`.
  `corepack enable` may fail with `EPERM` on Windows without an elevated shell; that's fine,
  `corepack pnpm` works either way and doesn't need it.
- pnpm blocks dependency postinstall/build scripts by default. If `pnpm install` reports
  `Ignored build scripts`, review the named package before approving it, then add it to
  `allowBuilds` in `pnpm-workspace.yaml` (e.g. `'@swc/core': true`) and reinstall — don't blanket-
  approve everything.

## Versioning & changelog

The whole repo is versioned as **one product** with `nx release` — **fixed** relationship, not
independent per-project (config in `nx.json` under `release`). All current and future
projects under `packages/`/`apps/` are matched via `release.projects: ["*"]`, which
deliberately overrides Nx's default behavior of excluding `"private": true` packages from
release (every project here is and will stay private — nothing is published to a registry).
One version bump moves every project's `package.json` together, and one root `CHANGELOG.md` is
generated — no per-project changelogs. New projects need **no extra release config** to be
included; that's the point of `"projects": ["*"]`.

- **Conventional Commits are required**, enforced by a `commit-msg` git hook
  (`.husky/commit-msg` → `commitlint`, config in `commitlint.config.js`) and re-checked in CI
  for PRs (`.github/workflows/ci.yml`) since the local hook can be bypassed with `--no-verify`.
  `nx release`'s version bump and changelog categorization are both inferred from these commit
  types (`release.version.conventionalCommits: true` in `nx.json`) — a non-conventional commit
  (like this repo's own history before this was set up) is silently invisible to versioning, not
  an error, so get the format right rather than relying on anything to catch it later.
- To cut a release: `pnpm run release` (interactive) or `pnpm run release:dry-run` to preview
  first. This bumps versions, writes `CHANGELOG.md`, commits, and tags (`v{version}`) — it does
  **not** push or publish anywhere by default (nothing here is published; ask before adding
  `--yes`/publish steps to CI).

## Project context

See `docs/PLAN.md` for the full design of the CoD2 Admin Telegram/RCON bot this workspace is
building (architecture, phased delivery plan in §9, dev/test environment in §11). `docs/PLAN-ru.md`
is a condensed Russian summary for the server owner, kept in sync with the same decisions.

`docs/PLAN-miniapp.md` is the companion plan for the Telegram Mini App (Angular + Material 3), a
second, graphical admin surface alongside the chat bot. Phases M1–M4 and the installer's HTTPS
step are implemented (2026-10-07, see its §0); M5 is open:

- web app: `apps/miniapp-web` (Angular, outside the TS project-reference graph — Nx's Angular
  plugin needs `NX_IGNORE_UNSUPPORTED_TS_SETUP=true` for generators; own `tsc --noEmit` typecheck)
- backend: `apps/gateway/src/miniapp/` (Fastify, in the gateway process, off unless
  `MINIAPP_PORT` is set); `api-types.ts` there is the contract both apps compile
- installer: `installer/lib/miniapp.sh` (Caddy + own domain or `<ip>.sslip.io`)
- local dev loop: `nx serve miniapp-web` proxies `/api` to 127.0.0.1:18090. Don't start the full
  gateway locally with the shared dev bot token — the NAS instance uses the same token.

`docs/PLAN-miniapp-ru.md` is its condensed Russian summary for the server owner, kept in sync the
same way as the `PLAN.md`/`PLAN-ru.md` pair — update it whenever `docs/PLAN-miniapp.md` changes.

`docs/PLAN-russia-access.md` covers game hosts in Russia, where Telegram has been blocked since
March 2026 (`api.telegram.org` unreachable from most Russian hosting). Part A is implemented
(2026-10-04, see its §0):

- free relays on Deno Deploy and Cloudflare Workers (`packages/telegram-relay`, shared instances
  built in as `DEFAULT_TELEGRAM_RELAYS`, mirrored in `installer/install.sh`)
- route failover in `apps/gateway/src/lib/telegram-routes.ts`
- owner-only `/relays` to manage routes from Telegram
- an installer that tries the same routes

Deploying the Deno relay must happen from a folder _outside_ this repo: the Deno CLI rewrites a
nearby `package.json` from `pnpm-workspace.yaml`. Admins' own Telegram access (part B) is still
open. `docs/PLAN-russia-access-ru.md` is its Russian summary — keep it in sync the same way.

Current status (2026-10-06): Phases 0–3 and self-update are done, released (v1.6.0, see
`CHANGELOG.md`) and verified live — against the dev CoD2 server and Telegram group, and in
production managing a real ~40-player public server over RCON only (no `!report` there, since
the bot doesn't run on that host). `docs/PLAN.md` §9 has a per-phase summary.

- Packages: `rcon-client` (Phase 0), `admin-store`/`ban-store` (Postgres via Drizzle, Phase 2),
  `log-tailer`/`report-pipeline` (Phase 3, `!report` cards), `telegram-relay` (deployed
  separately, see above). The bot itself is `apps/gateway` (grammy).
- Since Phase 3: self-update via `/update` (§13), servers managed from Telegram
  (`/addserver`/`/removeserver`/`/setdefault`), bans that apply on every server, IP country
  labels, CP1251 text, and Telegram relays.

Before touching `rcon-client`, read the server quirks in `docs/PLAN.md` §2.4 — they were all
found on real servers and are easy to reintroduce:

- `status` table parsing (`status-parser.ts`): column widths lie, and long names overflow.
- `kick` takes a name, not a slot, with quoting that differs for ASCII and Cyrillic names.
- Text is CP1251 and must be quoted, or the server drops every non-ASCII byte.
- `banClient`/`unbanUser` and anything that writes `ban.txt`: `unbanUser` matches by player
  name, not GUID (§2.4 "`ban.txt`", 2026-10-06).
- Most real players have GUID 0, so most bans are IP bans. §2.4 "Getting a real GUID" covers
  why, and what CoD2x would change.
