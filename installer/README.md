# cod2admin — installer

A Telegram bot for admins of a Call of Duty 2 dedicated server: ban/kick/tempban players,
receive `!report` cards from players in-game, manage other admins, and more.

This installs **only the bot** — it needs a CoD2 dedicated server that is *already installed and
running* somewhere reachable from this machine. It never touches that server's files.

## What you need before you start

- A Linux machine (Debian/Ubuntu or Alpine) that can reach your CoD2 server's RCON port. Running
  the installer directly on the same machine as the game server is the simplest setup.
- Root access on that machine (the installer installs system packages and a background service).
- A Telegram bot token. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
  and follow the prompts — it gives you a token like `123456789:AAH...`.
- Your CoD2 server's RCON password (from its `server_mp.cfg`, the `rcon_password` line) and the
  host/port it listens on.
- Optionally, the path to that server's `games_mp.log` file, if you want live match reports
  (`!report`) and join/leave tracking. You can skip this and add it later.

## Install

1. On the target machine, download and extract the latest release — this always gets the
   newest version, no version number to look up or type in:
   ```sh
   curl -s https://api.github.com/repos/constantant/cod2admin/releases/latest \
     | grep browser_download_url | grep -v gateway | cut -d '"' -f 4 | xargs curl -LO
   tar -xzf cod2admin-*.tar.gz
   cd cod2admin-*/
   ```
   The archive contains everything needed: `install.sh`, this README, and the bot itself.
2. Run:
   ```sh
   sudo ./install.sh
   ```
3. Answer the questions as they come up — each one explains what it's for and why it's needed.
   The installer checks your answers as you go (it actually pings your Telegram bot token and
   your CoD2 server before accepting them), so mistakes get caught immediately instead of causing
   a confusing failure later.
4. When it finishes, it prints either:
   - a `/claim <secret>` code — message your bot on Telegram with that command to become its
     owner, or
   - nothing extra, if you gave it your Telegram user ID during setup (you're already the owner).

That's it — the bot is now running as a background service and will restart automatically if it
crashes or the machine reboots (on hosts with systemd or OpenRC; see "Limitations" below).

## Updating

The bot messages its owner on Telegram when a new release comes out. Send `/update` to install
it: the bot downloads it, checks its checksum, and restarts on the new version. If the new
version doesn't start, it rolls back to the previous one by itself and tells you.

## More than one server

One bot can manage several CoD2 servers. The owner adds them from Telegram with
`/addserver <alias> <host:port> <rcon password>`, sent in a private chat with the bot. Bans
apply on every server the bot manages. Servers added this way are reached over RCON only, so
`!report` works only for the server whose `games_mp.log` path you gave the installer.

## Re-running the installer

Running `sudo ./install.sh` again on a machine that already has cod2admin installed lets you
reconfigure it (change the Telegram token, RCON details, etc.) without losing your existing
admin list, ban history, or audit log — those live in the database, untouched by reconfiguration.

## Advanced: unattended installs

For provisioning many servers the same way, `install.sh` also accepts a config file instead of
interactive prompts:

```sh
sudo ./install.sh --config my-server.conf
```

`my-server.conf` is a plain `KEY=VALUE` file, one per line — for example:

```sh
TELEGRAM_BOT_TOKEN=123456789:AAH-your-real-bot-token-from-BotFather
OWNER_TELEGRAM_ID=987654321
COD2_SERVER_ALIAS=default
COD2_RCON_HOST=127.0.0.1
COD2_RCON_PORT=28960
COD2_RCON_PASSWORD=the-rcon_password-from-server_mp.cfg
COD2_LOG_PATH=/path/to/games_mp.log
DB_MODE=local
```

`OWNER_TELEGRAM_ID` and `COD2_LOG_PATH` are optional (see above for what leaving them out means).
`DB_MODE=local` has the installer manage its own Postgres — use `DB_MODE=external` plus a
`DATABASE_URL=postgres://user:password@host:5432/dbname` line instead to point at a Postgres you
already run yourself. Run `./install.sh --help` for the full, authoritative field list.

## Telegram blocked?

Since March 2026, servers in Russia (and some other networks) can't connect to Telegram's Bot API
directly. The bot handles this itself. If it can't reach `api.telegram.org`, it switches to
free relays run for this project, so installing and running work as usual, with nothing to set
up. During install you'll see `Connected as @yourbot (via relay ...)`.

- **Change routes from Telegram:** the bot's owner can see and change the routes with
  `/relays`. `/relays test` checks them, and `/relays add <url>` adds your own relay.
- **Use only your own relays:** deploy one (free, see
  [`packages/telegram-relay/README.md`](../packages/telegram-relay/README.md)) and put this in
  the `--config` file:
  ```sh
  TELEGRAM_RELAYS=https://your-relay.example
  TELEGRAM_DIRECT=false        # optional: don't try api.telegram.org at all
  ```
- **If no route works during install:** the installer asks for a relay URL, or lets you finish
  anyway. The bot keeps retrying in the background.

Admins in Russia also need a way to open Telegram on their own phones (a VPN or an MTProto
proxy). The relays only cover the bot's own connection.

## Limitations

- Supports Debian/Ubuntu and Alpine hosts today (the two most common bases for CoD2 dedicated
  server hosting). Other distributions aren't detected and the installer will stop with a clear
  message rather than guessing.
- On a host with neither systemd nor OpenRC (most commonly a minimal container), the bot runs as
  a background process instead of a supervised service — it won't restart itself if it crashes.
  The installer tells you this explicitly when it happens.
