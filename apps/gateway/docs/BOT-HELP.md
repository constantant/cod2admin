# cod2admin bot — help

This bot manages a Call of Duty 2 server and lets players report misbehaving players
directly from in-game chat. Send `/help_ru` for this same guide in Russian.

## Reporting a player (anyone can do this, in-game)

Type this in your normal in-game chat (or team chat): `!report <name> <reason>`

Example: `!report Cheatr123 aimbot`

- `<name>` doesn't need to be exact — a distinctive part of it is enough (case-insensitive).
- `<reason>` is optional but helps admins decide faster.
- If you can't read or type the name (e.g. it's in a script you don't know), just put anything
  and describe what you saw instead — team, score, weapon, timing — admins can still find the
  right player from that.
- This posts a report card here in this chat for an admin to act on. Spamming the same report
  repeatedly is rate-limited.

## Commands for every role (moderator and up)

- `/status` — server name, map, player count
- `/players` — detailed player list with IP addresses, their country and provider (🛡 marks a VPN,
  proxy or Tor IP)
- `/servers` — list of servers this bot manages

## Moderator commands

- `/kick <client id or name> [--server <alias>]`
- `/tempban <client id> [duration] [reason] [--server <alias>]` — duration like `30m`, `2h`, `7d`;
  defaults to 30 minutes if omitted. Bans the player's GUID if the server reports one, otherwise
  their IP.

## Admin commands

- `/ban <client id> [reason] [--server <alias>]` — permanent
- `/unban <guid-or-ip>` — lifts the ban on all servers
- `/bans` — list currently active GUID/IP bans, with the server each was issued on
  Bans (including `/tempban`) apply on **all** servers this bot manages, not just the one the
  player was banned on — `--server` only picks which server to find the player on.
- `/map <name> [--server <alias>]` — the name is checked against the maps installed on the
  server, with suggestions for a typo
- `/maps [--server <alias>]` — tap-to-switch buttons: the maps in rotation, then every other map
  installed on the server. ⚠ marks a non-standard map: players who don't have it may be dropped
  unless the server offers downloads, so the bot asks before switching to one
- `/say <message> [--server <alias>]` — broadcasts to the game server's chat
- `/bindserver <alias>` — makes **this** chat receive report cards for that server
- `/setdefault <alias>` — which server commands without `--server` go to
- `/vpnnets` — provider networks shown as 🛡 VPN, for VPNs the built-in lists miss.
- `/vpnnets add <player IP or ASN>` marks the whole network of that IP (e.g. a VPN player's IP
  from `/players`); `/vpnnets remove <ASN>` unmarks it. Only a mark — nobody is kicked for it
- `/vpnkick on|off` — kick players marked 🛡 on sight, on every server, with a message in the game
  chat (off by default; nobody is banned). `/vpnkick allow <GUID or name>` exempts a trusted
  player, `/vpnkick unallow` undoes it, `/vpnkick` shows the state
- `/addadmin <telegram-id-or-reply> <admin|moderator>` — reply to the person's message, or give
  their numeric Telegram ID; only the owner can grant `admin`, an admin can grant `moderator`
- `/removeadmin <telegram-id-or-reply>`
- `/setrole <telegram-id-or-reply> <admin|moderator>`
- `/listadmins` — everyone with access and their role

## Owner-only commands

- `/auditlog [n]` — last n actions (default 10, max 50)
- `/rcon <raw command> [--server <alias>]` — sends anything directly to the game server console
- `/addserver <alias> <host:port> <rcon password>` — adds another server to manage (or updates
  one you added before). Send it in a private chat with the bot, never in a group: the bot
  deletes the message because it contains the password, then checks the server answers before
  saving anything
- `/removeserver <alias>` — stops managing a server added with `/addserver`
- `/update` — installs the newest release of this bot after you confirm; the bot also messages
  the owner when one comes out
- `/relays` — how the bot reaches Telegram: directly, or through relays where Telegram is blocked
  (e.g. servers in Russia). `/relays test` checks every route; `add <url>`, `remove <n>`,
  `direct on|off` and `reset` change the list, effective immediately

## Roles

`moderator` < `admin` < `owner`. Higher roles can do everything a lower role can, plus more —
see the command lists above for exactly where each cutoff is.

## Getting access

If you were just set up as this bot's owner via a secret code, message the bot directly (not in
this group) with:
- `/claim <secret>`

Everyone else needs an existing admin to run `/addadmin` for them.

## Long lists

When `/players`, `/bans`, `/auditlog` or `/rcon` would be a long message, the bot sends a short
summary and attaches the full list as a `.md` file (a plain-text table: IP, city, provider,
GUID, reasons…). Open it with any text viewer.

## Multi-server note

Most commands take an optional `--server <alias>` at the end if this bot manages more than one
server — see `/servers` for the list of aliases. Without it, a command goes to the server bound
to this chat (`/bindserver`), otherwise to the default server (`/setdefault`). The server from
the bot's config file can't be changed or removed from Telegram.

IP location and provider data by [DB-IP.com](https://db-ip.com) (CC BY 4.0). VPN ranges by
X4BNet (github.com/X4BNet), Tor exits by the Tor Project.
