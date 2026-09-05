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

Current status: Phase 0 (`packages/rcon-client`) and Phase 1 (`apps/gateway` — grammy Telegram
bot wrapping `rcon-client` with `/status`, `/players`, `/kick`, `/ban`, `/unban`, `/map`,
owner-only via `OWNER_TELEGRAM_ID`) are scaffolded and passing `test`/`build`/`typecheck`.
No `admin-store`/`ban-store`/roles/audit-log/multi-server support yet (Phase 2) and no
`log-tailer`/`report-pipeline` (Phase 3). Before starting later-phase work, check `docs/PLAN.md`
§9 for what that phase covers and whether any of its "Open questions"/caveats (§10, §2.4's
GUID-0 verification) still apply.
