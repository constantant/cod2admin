# CoD2 dedicated server — dev container assets

This directory (`fs_basepath`, the game data) is seeded into the `cod2_server` service's named
volume by the `cod2_server_seed` one-shot service in the root `docker-compose.yml`, backing the
local dev/test CoD2 server described in `docs/PLAN.md` §11. `docker/cod2server/homedir` (separate,
`fs_homepath`, a real bind mount) is where the server writes generated files — config, logs,
punkbuster state — see "Known issue" below for why these two are split.

## One-time setup

1. **Add game files** (required, not included — see Licensing below): copy `iw_00.iwd` through
   `iw_15.iwd` and the `localized_*_iwXX.iwd` files from an original CoD2 install (retail, Steam,
   or the [archive.org dev build](https://archive.org/details/dev-cod2)) into this directory,
   alongside `server_mp.cfg`.
2. Confirm `server_mp.cfg`'s `rcon_password` matches `COD2_RCON_PASSWORD` in the repo root
   `.env` (copied from `.env.example`). The game engine reads the password from this file; the
   gateway reads it from `.env`. Nothing keeps the two in sync automatically — change both if you
   change either.
3. From the repo root:
   ```sh
   docker compose run --rm cod2_server_seed   # copy this directory into the named volume
   docker compose up -d cod2_server
   ```
   The server writes its multiplayer event log to `$fs_homepath/main/games_mp.log`
   (`fs_homepath` is set to `/home/cod2/homedir` at launch, in `docker-compose.yml`'s
   `command:`), which lands at `docker/cod2server/homedir/main/games_mp.log` on the host — this
   is the file `log-tailer` reads (`COD2_LOG_PATH` in `.env`).

## Known issue: fs_basepath is a named volume, fs_homepath is a bind mount

Two separate volumes back this container, for two different reasons:

- **`fs_basepath`** (this directory → the named volume `cod2admin-dev-cod2-main`): a *bind*
  mount of `./docker/cod2server/main` here hits an open upstream bug
  ([bgauduch/call-of-duty-2-docker-server#94](https://github.com/bgauduch/call-of-duty-2-docker-server/issues/94)) —
  the game binary reports "0 files in iwd files" and refuses to start, even though the `.iwd`
  files are present/readable in the container. Working around it means the game data can't be
  bind-mounted, so it's seeded into a named volume instead (`cod2_server_seed`, re-run after
  editing anything here) — but that also means nothing under `/home/cod2/main` reaches the host
  filesystem, which is why `games_mp.log` can't live there either.
- **`fs_homepath`** (`docker/cod2server/homedir` → a real bind mount): only ever holds small
  generated text files (config, logs, punkbuster state), never the `.iwd` game data, so it
  doesn't hit the #94 bug above. Explicitly redirecting `fs_homepath` here (rather than the
  image's default, `~/.callofduty2`) is also what makes `games_mp.log` tailable as a plain file
  at all — the image ships its default homepath's `games_mp.log` **pre-symlinked to
  `/dev/stdout`** (merged into `docker logs`, confirmed via `docker exec ... ls -la`), not as a
  real file. Found and fixed 2026-09-06; see `docs/PLAN.md` §2.4/§11.1 for the investigation.

## Licensing

The dedicated server *binary* is freely distributed by the upstream project below. CoD2's
`.iwd` game data files are **not** — you need your own legitimate copy of Call of Duty 2 to
extract them from. Don't commit `.iwd` files to this repo (already covered by `.gitignore`).

## Credits / upstream

Built on [bgauduch/call-of-duty-2-docker-server](https://github.com/bgauduch/call-of-duty-2-docker-server)
(also linked in `docs/PLAN.md` §Sources). `server_mp.cfg` and `punkbuster.cfg` here are copies of
that project's defaults, with the hostname/MOTD/rcon password changed for this dev/test setup.
