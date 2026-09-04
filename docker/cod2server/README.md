# CoD2 dedicated server — dev container assets

This directory is bind-mounted into the `cod2_server` service defined in the root
`docker-compose.yml` (as `/home/cod2/main`), backing the local dev/test CoD2 server described in
`docs/PLAN.md` §11.

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
   docker compose up -d cod2_server
   ```
   The server writes its multiplayer event log to `./main/games_mp.log` inside the container,
   which lands at `docker/cod2server/main/games_mp.log` on the host — this is the file
   `log-tailer` reads (`COD2_LOG_PATH` in `.env`).

## Licensing

The dedicated server *binary* is freely distributed by the upstream project below. CoD2's
`.iwd` game data files are **not** — you need your own legitimate copy of Call of Duty 2 to
extract them from. Don't commit `.iwd` files to this repo (already covered by `.gitignore`).

## Credits / upstream

Built on [bgauduch/call-of-duty-2-docker-server](https://github.com/bgauduch/call-of-duty-2-docker-server)
(also linked in `docs/PLAN.md` §Sources). `server_mp.cfg` and `punkbuster.cfg` here are copies of
that project's defaults, with the hostname/MOTD/rcon password changed for this dev/test setup.
