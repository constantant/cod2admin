# cod2admin — installer

A Telegram bot for admins of a Call of Duty 2 dedicated server: ban/kick/tempban players,
receive `!report` cards from players in-game, manage other admins, and more.

This installs **only the bot** — it needs a CoD2 dedicated server that is _already installed and
running_ somewhere reachable from this machine. It never touches that server's files.

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
apply on every server the bot manages. For `!report` on a server, the bot also needs to read its
`games_mp.log`, see below.

## Connecting the game log

`!report` cards and the Mini App's chat need the bot to read the server's `games_mp.log` as a
local file. RCON can't deliver it, and every other command works without it.

The owner sends `/findlog` to the bot (`/findlog --server <alias>` for a specific server). It finds
the log and starts reading it, with no restart. To get `!report` cards, also send
`/bindserver <alias> private` in your admins' group. To post match results to a public group, send
`/bindserver <alias>` there (without a public group, results go to the admins' group). `private` is refused in a public group (one with a public `@username`, or already bound as public). If the bot can't connect the log, it tells you what to
do. These are the cases:

**The bot can't read the file.** The bot replies with commands for your exact path. Run them on
the server as root. For example, with the bot's default user:

```sh
setfacl -m u:cod2admin:x /home /home/cod2 /home/cod2/main
setfacl -m u:cod2admin:r /home/cod2/main/games_mp.log
setfacl -d -m u:cod2admin:r /home/cod2/main
```

The first line lets the bot through each folder, the second lets it read the file, and the third
keeps that working if the server creates the file again. Only the bot's user gets access. If
`setfacl` is missing, install the `acl` package.

**The bot can't find the file, but the game server is on the same machine.** The bot can't search
folders it can't open. Find the log as root with `find / -name games_mp.log 2>/dev/null`, then send
`/findlog <that path>`. The bot then replies with the commands above.

**The game server runs in Docker.** The log has to exist on the machine, so its folder must be a
bind mount, not a named volume. The server writes to `<fs_homepath>/main/games_mp.log`, so mount
`fs_homepath` to a folder on the machine.

**The bot runs in a container.** It only sees folders mounted into it. Mount the log's folder
read-only (`/path/on/host/main:/cod2-logs:ro`), recreate the container, and send `/findlog`. Then
make the log readable on the machine with `chmod o+r games_mp.log`, plus `o+x` on its folder and
every folder above it. Note that this lets every user on the machine read the log. With the Docker
kit, give the folder to `run.sh`, see `docker/README-ru.md`.

**The game server is on another machine.** The bot can't read the log from there. Install the bot
on the game server's machine. Without the log, everything except `!report` and the Mini App's chat
still works.

**The server doesn't write a log.** Set `g_log "games_mp.log"` and `g_logsync "1"` in its config,
and restart it.

## The Mini App (server manager inside Telegram)

Besides chat commands, the bot has a full-screen app that opens inside Telegram: live players
with kick/ban buttons, the in-game chat (read and write), map switching, and a ban list you can
search and edit. Admins open it with the menu button in their private chat with the bot, or with
`/app`. It uses the same admin roles as the commands, and everything done in it goes into
`/auditlog`.

Telegram only opens it over HTTPS, so the installer asks whether to turn it on and then:

- uses your domain if you enter one (point its DNS at this server first), or else a free
  `<your-ip>.sslip.io` name — nothing to register or configure;
- installs [Caddy](https://caddyserver.com), which gets the HTTPS certificate by itself, and
  puts the app behind it. Ports **80 and 443** must be open to the internet (the installer opens
  them in `ufw`; a firewall in your hosting panel you open yourself).

If ports 80/443 are already used by a web server you run (nginx, Apache), Caddy isn't
installed; the installer prints the proxy rule to add to yours instead. For `--config` installs,
add `MINIAPP_ENABLED=true` (and optionally `MINIAPP_DOMAIN=bot.example.com`), or set
`MINIAPP_URL=https://...` if you handle HTTPS yourself. Existing installs: re-run `install.sh`
to turn it on.

The live chat needs the `games_mp.log` path; without it the app still does everything else.

### Mini App behind NAT

A server at home behind a router (no public IP) can't be reached by Telegram directly. A free
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
fixes that without opening any port:

1. Re-run the installer and turn the Mini App on — it detects the NAT and starts the app on
   `127.0.0.1:18090` without Caddy.
2. Install `cloudflared` and create a tunnel to `http://127.0.0.1:18090` (with a free Cloudflare
   account and a domain on it; `cloudflared tunnel --url http://127.0.0.1:18090` gives a
   temporary URL for a quick test, but it changes on every restart).
3. Put the tunnel's address in `/opt/cod2admin/.env` as `MINIAPP_URL=https://...` and restart the
   bot. It sets the menu button to that address on start.

## Re-running the installer

Running `sudo ./install.sh` again on a machine that already has cod2admin installed lets you
reconfigure it (change the Telegram token, RCON details, etc.) without losing your existing
admin list, ban history, or audit log — those live in the database, untouched by reconfiguration.
Saved RCON passwords keep working too, because it keeps the existing encryption key (versions before
1.16.1 replaced it, so don't reconfigure with those).

`.env` is rewritten from your answers, so any setting the installer doesn't ask about, such as
`GEOIP_CITY_ENABLED`, is dropped. The previous file is saved next to it as `.env.bak-<date>`: copy
back whatever you had added.

## If `/update` starts but never finishes on systemd

Installs from before 1.16.1 can have this problem: restarting the bot also stops the update script,
which leaves `update.lock` behind and blocks every later update. `/update` doesn't replace the update
script or the service settings, so fix this once by hand, as root, without reinstalling. Your
database and `.env` aren't touched:

```sh
cd /opt/cod2admin
curl -fL -o /tmp/cod2admin-installer.tar.gz https://github.com/constantant/cod2admin/releases/download/v1.16.1/cod2admin-1.16.1.tar.gz
tar -xzf /tmp/cod2admin-installer.tar.gz -C /tmp
cp /tmp/cod2admin-1.16.1/apply-update.sh bin/apply-update.sh
cp /tmp/cod2admin-1.16.1/lib/service.sh bin/lib/service.sh
mkdir -p /etc/systemd/system/cod2admin.service.d
printf '[Service]\nKillMode=process\n' > /etc/systemd/system/cod2admin.service.d/self-update.conf
systemctl daemon-reload
pgrep -f '[a]pply-update.sh' >/dev/null || rmdir update.lock
```

The last line prints an error if there was no lock, which is fine.

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
