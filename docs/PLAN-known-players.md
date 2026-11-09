# Known players — nickname ↔ ASN allowlist

Status: **implemented** (2026-11-09), branch `feat/known-players` — bot, plus the mini app page
("Known players" under More, same `vpn` permission; routes `/api/known*` in
`routes-management.ts`). Not yet tried on a real server. Russian summary: `PLAN-known-players-ru.md`. Decisions taken: immunity does not cover explicit bans/mutes; reuses the `vpn`
permission; kick only, no escalation; optional `known_kick` game-chat template (empty by default).
The migration is `0008_known_players`; another unmerged branch (`player-watch-bot`) also has a
`0008_watch` — renumber whichever merges second.

## 1. Goal

Admins keep a list of **known players**: a nickname plus the provider networks (ASNs) that player
normally connects from. The bot then enforces it on every server:

- A player whose nickname is in the list **and** whose current ASN is one of the stored ones is a
  _known player_: never kicked by the bot's automatic, heuristic kicks.
- A player who **uses a known nickname** but connects from an ASN that isn't stored for it is
  _impersonating or on a VPN_: kicked on sight (kick only, never a ban — the same reasoning as
  `/vpnkick`: the real owner may be on a new ISP/VPN and can come back, and the admin can then add
  the ASN).
- Nicknames not in the list are untouched.

The ASN comes from the DB-IP ASN database the bot already loads (`AsnDatabase.asn(ip)` in
`apps/gateway/src/lib/geoip.ts`), the same source `/vpnnets` uses.

## 2. Closest existing code (reuse, don't reinvent)

| Need                              | Existing piece                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Periodic sweep over every server  | `VpnKicker.sweep` (`lib/vpn-kick.ts`), called from `startExpiryPoller` (10 s tick) |
| Name normalising (colours, case)  | `displayName()` + `normalizeExempt()` in `commands/players.ts` / `vpn-kick.ts`     |
| IP → ASN                          | `deps.provider.asn(ip)` (`ProviderLookup`)                                         |
| Safe kick by name                 | `rcon.kick(num, sanitizeRconArg(name))` — see `docs/PLAN.md` §2.4 quirks           |
| Audit entry with `source: 'auto'` | `recordAuditLog` as in `VpnKicker.kick`                                            |
| Optional in-game line             | `ChatTemplates` (`vpn_kick` template, starts empty)                                |
| Admin-managed JSON state          | `adminStore.getSetting/setSetting` (as `vpn.kick`, `vpn.networks`)                 |

## 3. Design

### 3.1 Storage

A real table, not a settings blob (the list can grow to hundreds of entries and the mini app needs
per-row edits and audit):

```
known_players
  id          serial pk
  name        text not null unique   -- normalised: colour codes stripped, lower case
  display     text not null          -- name as the admin typed it, for lists
  asns        integer[] not null     -- ≥ 1 entry; ASNs fit in 32 bits → bigint[] (max AS is 4 294 967 295)
  note        text                   -- optional ("Vasya, Rostelecom + MTS mobile")
  created_by  bigint not null, created_at, updated_at timestamptz
```

`asns` is `bigint[]` (32-bit ASNs exceed int4). New drizzle migration `0008_known_players.sql` in
`packages/admin-store`, store methods `listKnownPlayers / upsertKnownPlayer / addKnownAsn /
removeKnownAsn / removeKnownPlayer`, in-memory fake in the store spec like the other tables.

### 3.2 Matching rule (pure function, easy to unit-test)

```
classify(player, known: Map<name, Set<asn>>, asnOf: (ip) => number | undefined):
  entry = known.get(normalize(displayName(player)))
  if (!entry)                              -> 'unknown'      // not our business
  asn = player.ip ? asnOf(player.ip) : undefined
  if (asn === undefined)                   -> 'known-unverified'  // fail OPEN: never kick
  if (entry.has(asn))                      -> 'known'
  else                                     -> 'impostor'     // kick
```

Fail-open when the ASN can't be determined (database not downloaded yet, LAN/private IP, a bot
address): we never kick a legitimate player because our data is missing.

Nickname normalisation is the same as `/vpnkick allow` uses, so `^1Vasya` and `vasya` are one entry.
GUID is deliberately **not** part of the key: most real players have GUID 0 (`docs/PLAN.md` §2.4
"Getting a real GUID"), so name + ASN is all we have.

### 3.3 Enforcement — new `KnownPlayers` service (`lib/known-players.ts`)

Holds the in-memory map (loaded at start, refreshed on every change, like `VpnKicker.setSettings`).
Exposes:

- `sweep(deps)`: for each server, `rcon.status()`, classify each player, kick `impostor`s
  (announce/audit at most once per name+IP per 5 min, like `VpnKicker`, but kick every sweep).
  Runs from `startExpiryPoller` next to `vpnKick.sweep`. To avoid querying each server twice per
  tick, the preferred refactor is a shared "players per server" fetch for both sweeps — optional,
  can be a follow-up.
- `isKnown(player)`: true for `known` **and** `known-unverified`; used by the other auto-kickers as
  an exemption (§3.4).

### 3.4 What "never kicked" covers

| Auto action                             | Known player (name + ASN match)                           |
| --------------------------------------- | --------------------------------------------------------- |
| `/vpnkick` (VPN/proxy/Tor/hosting)      | **Exempt.** Needs the hook in `isExempt` in `vpn-kick.ts` |
| Mute-enforcer kick (`mute-enforcer.ts`) | Not exempt — an admin muted them on purpose               |
| Ban enforcement sweep (`ban-store`)     | Not exempt — an explicit ban always wins (see Q1)         |
| Manual `/kick`, `/ban`, `/tempban`      | Unaffected; these are explicit admin actions              |

Warn the admin instead of silently conflicting: when an admin adds a known player whose name or
current IP is under an active ban, or kicks/bans a known player, the reply says "this player is in
the known list" so the list isn't mistaken for protection from admins.

### 3.5 Admin interface

**Telegram**, new `/known` command (`lib/commands/known.ts`, registered in `bot.ts`), permission
see Q2:

```
/known                         list: name — AS12389 Rostelecom, AS8359 MTS …
/known add <name> [ASN …]      with no ASN: take the ASN of the player currently on the server
                               with that name (like `/vpnnets add <IP>`), error if offline
/known asn <name> add|remove <ASN>
/known remove <name>
/known note <name> <text>
```

Every change writes an audit entry (`known_add`, `known_asn_add`, …). ASN input accepts `12389` or
`AS12389` (reuse `parseAsn` from `vpnnets.ts`, move it to a shared helper). `/players` lines get a
small marker (e.g. `✅`) for known players, `⚠️` for an impostor in the instant before the sweep
kicks, so admins see why someone vanished.

**Mini app** (follow-up PR, after the bot side is verified): a "Known players" page next to VPN
networks — table with name, ASN chips (provider name resolved from the ASN database when
available), add/remove, note; routes in `routes-management.ts`, types in `api-types.ts`, Russian
strings in `i18n-ru.ts`. Also an "add as known" action on the player card in the live players list.

### 3.6 Edge cases

- **Mobile / dual-ISP players** have several ASNs — that is why it's a list; `/known asn … add`
  covers the "kicked, but it was really them" case in one command.
- **Same nickname, two real people** (common short names): the list is name-keyed, so both would
  need to share one entry's ASNs. Accepted limitation; documented in `/help`.
- **ASN database is monthly and free (DB-IP Lite)**: an IP can move between ASNs after a refresh.
  Worst case is one legitimate kick, fixed by `/known asn add`. Provider names in `/known` output
  show what the bot currently believes.
- **Spoofing the other way**: someone with the same ASN (same ISP) and the same nickname passes.
  The ASN is a coarse check, not authentication — state this in the docs; GUID-based identity stays
  out of scope until CoD2x (`docs/PLAN.md` §2.4).
- **Name quirks**: the matching name is what `status` shows; CP1251/Cyrillic names go through the
  existing normalisation. Kick uses `sanitizeRconArg(player.name)` like the other kickers.
- **Feature off switch**: `/known on|off` (setting `known.enabled`, default **off** at first
  release, like `/vpnkick`) so a freshly deployed list can't start kicking people before an admin
  has reviewed it. Exemption from `/vpnkick` works only while on.

## 4. Delivery steps

1. **Store**: schema + migration `0008`, store methods, specs (`packages/admin-store`).
2. **Core**: `lib/known-players.ts` (`classify`, `KnownPlayers` with sweep + `isKnown`), specs with
   a fake `rcon` and fake `asn` lookup, covering every row of §3.2 and fail-open.
3. **Hook into `vpn-kick.ts`** exemption; wire `deps.knownPlayers`, `main.ts` load, poller call.
4. **`/known` command** + permission + audit + `/players` marker + `/help` (EN and RU:
   `apps/gateway/docs/BOT-HELP*.md`), command spec.
5. **Mini app** page and routes (separate commit/PR).
6. Docs: this file's §0 status, `docs/PLAN.md` §9 line, a RU summary `PLAN-known-players-ru.md`.
7. Verify against the dev bot/server on the NAS (never run the full gateway locally with the shared
   dev token). Then `pnpm nx run-many -t lint test typecheck`, conventional commits (`feat:`).

## 5. Open questions

1. **Does a known player's immunity also cover explicit bans?** Recommended: no — a ban is a
   deliberate admin decision; the known list only suppresses _automatic, heuristic_ kicks.
2. **Permission**: add a new `known.manage` permission (needs a permissions migration and giving it
   to admins by default, as `0006_permissions.sql` did) or reuse `vpn`? Recommended: reuse `vpn` in
   the first release — it's the same trust level and avoids a migration — and split later if
   needed.
3. **Mismatch action**: kick only, as requested. Should repeated mismatches (e.g. 5 in 10 minutes)
   escalate to a temp-ban? Recommended: no, keep it kick-only.
4. **Announcement**: a game-chat line when an impostor is kicked (new `known_kick` template, empty
   by default) — wanted, or audit-only?

## 6. GUIDs (added 2026-11-09)

An entry may also hold real GUIDs (`known_players.guids`, migration `0009`). Most players have GUID
0 (`docs/PLAN.md` §2.4), so the ASN stays the base check; a GUID only adds information when present:

1. A real GUID stored for the name → **known**, from any network.
2. A real GUID not among the stored ones, network fits (or unknown) → **suspect**: flagged ⚠️ and,
   since 2026-11-09, **kicked** like an impostor (the audit entry says `reason: guid`). A new CD key
   means a new GUID, so an admin adds it with "mark as known"; until then they are kicked. Not
   exempt from `/vpnkick`.
3. Network doesn't fit and no stored GUID vouches → **impostor**, kicked as before (with a GUID
   that differs too, the kick audit entry carries it).
4. GUID 0 or none stored → ASN decides. An entry with no ASNs (GUID only) has no network to check.

"Mark as known" (Mini App sheet) and `/known add` store the player's real GUID next to the ASN; the
sheet's button text follows the verdict (new / add network / add GUID).
