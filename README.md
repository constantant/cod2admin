# cod2admin

A Telegram/RCON admin bot for Call of Duty 2 dedicated servers: ban/kick/tempban players,
receive `!report` cards from players in-game, manage other admins, and more.

- **Using the bot on your server?** See [`installer/README.md`](./installer/README.md).
- **Contributing code?** See [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- **Project design/roadmap:** see [`docs/PLAN.md`](./docs/PLAN.md) (condensed Russian summary:
  [`docs/PLAN-ru.md`](./docs/PLAN-ru.md)).

## Layout

This is a pnpm/Nx workspace:

- `apps/gateway` — the Telegram bot (grammy)
- `packages/rcon-client` — CoD2 RCON protocol client
- `packages/admin-store`, `packages/ban-store` — Postgres-backed admin roles and ban records
  (Drizzle)
- `packages/log-tailer`, `packages/report-pipeline` — live `games_mp.log` tailing and the
  `!report` pipeline
- `installer/` — the standalone installer bundle shipped to CoD2 server admins
  (see `scripts/build-installer-bundle.sh` and `scripts/release.sh`)

## Development

```sh
pnpm install
pnpm exec nx run-many -t lint test build typecheck e2e
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for commit conventions and the PR/CI flow.
