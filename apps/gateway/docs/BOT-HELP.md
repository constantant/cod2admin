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

## Commands for every staff member

Anyone in the staff list can use these, including someone with no permissions (`none` in
`/listadmins`). The owner can use every command below.

- `/status` — server name, map, player count
- `/players` — detailed player list with IP addresses, their country and provider (🛡 marks a VPN,
  proxy or Tor IP)
- `/servers` — list of servers this bot manages
- `/app` — opens the server manager app inside Telegram (players, chat, reports, maps, bans, notes
  and more), when the bot's owner turned it on. In a private chat with the bot, the menu button
  opens it too.
- `/mcp` — connect your own AI, in a private chat with the bot. Add the address it shows in
  the app. Leave the browser page open, press Approve in Telegram (it opens beside the page),
  choose Allow, then go back to the page. It returns you to the app. `/mcp` lists the
  connections, `/mcp revoke <id>` ends one,
  `/mcp revoke all` ends all of them. The app only gets the actions you approved and still hold.
  Updating the bot, Telegram relays, the staff list and adding a server stay in this chat

## Commands by permission

Each command needs the permission in its heading. `/permit` is how those permissions are given.

### `kick`

- `/kick <client id or name> [--server <alias>]`
- On a report card, Kick needs this permission.

### `tempban`

- `/tempban <client id> [duration] [reason] [--server <alias>]` — duration like `30m`, `2h`, `7d`;
  defaults to 30 minutes if omitted. Bans the player's GUID if the server reports one, otherwise
  their IP.
- On a report card, Temp ban needs this permission.

### `ban`

- `/ban <client id> [reason] [--server <alias>]` — permanent
- `/unban <guid-or-ip>` — lifts the ban on all servers
- `/bans` — list currently active GUID/IP bans, with the server each was issued on
  Bans (including `/tempban`) apply on **all** servers this bot manages, not just the one the
  player was banned on — `--server` only picks which server to find the player on.
- On a report card, Ban needs this permission. Resolve and Ignore need only to be staff.

### `maps`

- `/map <name> [mode] [--server <alias>]` — the name is checked against the maps installed on the
  server, with suggestions for a typo. Add a game mode (`ctf`, `tdm`, `dm`, `sd`, `hq`, or a mod's
  own) to switch it too, e.g. `/map mp_toujane ctf`; without one the map loads in the current mode
- `/maps [--server <alias>]` — tap-to-switch buttons: the maps in rotation, then every other map
  installed on the server. ⚠ marks a non-standard map: players who don't have it may be dropped
  unless the server offers downloads, so the bot asks before switching to one

### `say`

- `/say <message> [--server <alias>]` — broadcasts to the game server's chat

### `servers.assign`

- `/bindserver <alias>` — makes **this** chat receive report cards for that server
- `/setdefault <alias>` — which server commands without `--server` go to

### `vpn`

- `/vpnnets` — provider networks shown as 🛡 VPN, for VPNs the built-in lists miss.
  `/vpnnets add <player IP or ASN>` marks the whole network of that IP (e.g. a VPN player's IP
  from `/players`); `/vpnnets remove <ASN>` unmarks it. Only a mark — nobody is kicked for it
- `/vpnkick on|off` — kick players marked 🛡 on sight, on every server, with a message in the game
  chat (off by default; nobody is banned). `/vpnkick allow <GUID or name>` exempts a trusted
  player, `/vpnkick unallow` undoes it, `/vpnkick` shows the state

### `admins.manage`

- `/addadmin <telegram-id-or-reply>` — reply to the person's message, or give their numeric
  Telegram ID. Adds them with no permissions (they can use the staff commands above). If they are
  already staff, their permissions are left alone — change them with `/permit`
- `/permit <telegram-id-or-reply> [kick, tempban, mute]` — replaces their permissions. Separate
  ids with commas or spaces. With no ids, the list is cleared. If they already have `rcon` or
  `update` and you leave those out, they keep them
- Only the owner can give or take `rcon` and `update`. Holding those permissions does not let you
  pass them on, and omitting them does not take them away
- `/removeadmin <telegram-id-or-reply>` — nobody can remove the owner or themselves. Anyone with
  `admins.manage` can remove other staff
- `/listadmins` — everyone with access. The owner is shown as `owner`. Everyone else is shown as
  their permission ids, or `none`

### `audit`

- `/auditlog [n]` — last n actions (default 10, max 50)

### `rcon`

- `/rcon <raw command> [--server <alias>]` — sends anything directly to the game server console.
  Only the owner can give or take this permission

### `servers.manage`

- `/addserver <alias> <host:port> <rcon password>` — adds another server to manage (or updates
  one you added before). Send it in a private chat with the bot, never in a group: the bot
  deletes the message because it contains the password, then checks the server answers before
  saving anything
- `/removeserver <alias>` — stops managing a server added with `/addserver`

### `logs`

- `/findlog [--server <alias>]` — finds the server's `games_mp.log` on the bot's machine and starts
  reading it, for `!report` cards and the app's chat. No restart needed. `/findlog <path>` uses a
  file you name, `/findlog off` stops reading the log. If the bot can't read the log, it replies
  with the commands to give it access

### `update`

- `/update` — installs the newest release of this bot after you confirm; the bot also messages
  the owner when one comes out. Only the owner can give or take this permission

### `relays`

- `/relays` — how the bot reaches Telegram: directly, or through relays where Telegram is blocked
  (e.g. servers in Russia). `/relays test` checks every route; `add <url>`, `remove <n>`,
  `direct on|off` and `reset` change the list, effective immediately

## Permissions

There is no moderator / admin / owner ladder. Each staff member has a set of permission ids.
An empty set is read-only staff. The owner has every permission, including ones with no chat
command: `mute`, `presets`, `cvars.read`, `cvars.write`, `servers.view`, `notes.manage`. Those
are used in the Mini App (`/app`).

Only the owner can give or take `rcon` and `update`. A non-owner can only include permissions
they hold, and cannot newly grant `rcon` or `update` even if they hold them.

An AI connected with `/mcp` can use only the permissions you approved for that connection, and
only while you still hold them. `update`, `relays`, `admins.manage` and `servers.manage` stay in
this chat. A read-only connection can read the in-game chat. Allow `say` on that connection to
let it speak: each line starts with your name, about once every 10 seconds. A connection that
can kick, ban, change the map, or send a console command does not receive the chat.

## Getting access

If you were just set up as this bot's owner via a secret code, message the bot directly (not in
this group) with:

- `/claim <secret>`

Everyone else needs someone with `admins.manage` to run `/addadmin` for them, then `/permit` for
the permissions they should have.

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
