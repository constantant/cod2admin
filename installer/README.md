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
     | grep browser_download_url | cut -d '"' -f 4 | xargs curl -LO
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

Run `./install.sh --help` to see the file format.

## Limitations

- Supports Debian/Ubuntu and Alpine hosts today (the two most common bases for CoD2 dedicated
  server hosting). Other distributions aren't detected and the installer will stop with a clear
  message rather than guessing.
- On a host with neither systemd nor OpenRC (most commonly a minimal container), the bot runs as
  a background process instead of a supervised service — it won't restart itself if it crashes.
  The installer tells you this explicitly when it happens.
