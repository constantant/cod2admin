*cod2admin bot — help*

This bot manages a Call of Duty 2 server and lets players report misbehaving players
directly from in-game chat. Send `/help_ru` for this same guide in Russian.

*Reporting a player (anyone can do this, in-game)*

Type this in your normal in-game chat (or team chat):
`!report <name> <reason>`

Example: `!report Cheatr123 aimbot`

- `<name>` doesn't need to be exact — a distinctive part of it is enough (case-insensitive).
- `<reason>` is optional but helps admins decide faster.
- If you can't read or type the name (e.g. it's in a script you don't know), just put anything
  and describe what you saw instead — team, score, weapon, timing — admins can still find the
  right player from that.
- This posts a report card here in this chat for an admin to act on. Spamming the same report
  repeatedly is rate-limited.

*Commands anyone here can use*

`/status` — server name, map, player count
`/players` — detailed player list with IP addresses
`/servers` — list of servers this bot manages

*Moderator commands*

`/kick <client id or name> [--server <alias>]`
`/tempban <client id> [duration] [reason] [--server <alias>]` — duration like `30m`, `2h`, `7d`;
defaults to 30 minutes if omitted. IP-based.

*Admin commands*

`/ban <client id> [reason] [--server <alias>]` — permanent
`/unban <guid-or-ip> [--server <alias>]`
`/bans [--server <alias>]` — list currently active GUID/IP bans
`/map <name> [--server <alias>]`
`/say <message> [--server <alias>]` — broadcasts to the game server's chat
`/bindserver <alias>` — makes *this* chat receive report cards for that server
`/addadmin <telegram-id-or-reply> <admin|moderator>` — reply to the person's message, or give
their numeric Telegram ID; only the owner can grant `admin`, an admin can grant `moderator`
`/removeadmin <telegram-id-or-reply>`
`/setrole <telegram-id-or-reply> <admin|moderator>`
`/listadmins` — everyone with access and their role

*Owner-only commands*

`/auditlog [n]` — last n actions (default 10, max 50)
`/rcon <raw command> [--server <alias>]` — sends anything directly to the game server console

*Roles*

`moderator` < `admin` < `owner`. Higher roles can do everything a lower role can, plus more —
see the command lists above for exactly where each cutoff is.

*Getting access*

If you were just set up as this bot's owner via a secret code, message the bot directly (not in
this group) with:
`/claim <secret>`

Everyone else needs an existing admin to run `/addadmin` for them.

*Multi-server note*

Most commands take an optional `--server <alias>` at the end if this bot manages more than one
server — see `/servers` for the list of aliases. Without it, commands act on the default server.
