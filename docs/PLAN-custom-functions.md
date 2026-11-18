# Custom functions — plan

Companion to `docs/PLAN-miniapp.md`. Status: **F1–F4 implemented 2026-11-18** (backend, editor and buttons, player actions and settings, import/export). Not yet opened in a real browser or Telegram client. See §10–§13.
Russian summary: `docs/PLAN-custom-functions-ru.md` (keep in sync).

## 1. Goal

A game-server owner sometimes runs a mod that adds its own commands and settings. These are too
niche to build into the bot, yet the owner still wants buttons and controls for them instead of typing
raw RCON. This feature lets the owner **define such functions inside the Mini App**, and turns each
definition into real UI.

### Decisions (2026-11-18)

- **Declarative, not scripting.** A function is a template of RCON commands plus typed parameters.
  No user-written code and no interpreter: a sandbox would be a large security and maintenance
  surface, and templates cover what mods need (`set`, `say`, custom admin commands, toggles).
- **Owner by default, grantable.** Only the owner can define functions at first. The owner can grant
  the right to define them to other staff, through the same mechanism as `rcon` today: only the owner
  can newly grant it, and a holder cannot pass it on.
- **Mini App only.** No Telegram exposure in this plan (`/run` can be revisited later).
- **Plain RCON reply as output.** Parsing replies is out of scope (§9).

## 2. Function kinds

| Kind | The owner defines | Becomes |
|---|---|---|
| **Action** | Title, 1–N RCON steps, typed parameters | A button on the server page; opens a form if it has parameters |
| **Player action** | Same, with an implicit `{player}` | An entry in the player row's menu |
| **Setting** | A cvar and a control type (toggle, number with min/max, select, text) | A control showing the current value and writing it |

Settings reuse the existing cvar read/write path (`cvars.read` / `cvars.write` behavior, same
CP1251 and quoting rules) rather than a second one.

### 2.1 Templates and parameters

A step is a command string with `{name}` placeholders, e.g. `scr_give {player} {weapon}`.

| Type | Value | Validation |
|---|---|---|
| `text` | free text | length cap; no CR/LF; no `;`; no `"` |
| `number` | integer or decimal | optional `min`/`max`/`step` |
| `choice` | one of a fixed list | must be in the list |
| `bool` | on/off | maps to two owner-defined strings (default `1`/`0`) |
| `player` | a connected player | resolved against live `status`; passed by slot or quoted name, as `kick` does |
| `map` | an installed map | must be in `getInstalledMaps()` |

Quoting and CP1251 encoding are done by `rcon-client` (PLAN §2.4), never by string concatenation in
the route. The raw template is stored; the resolved command exists only at run time.

## 3. Safety

- **Resolution happens only on the gateway.** The client sends a function id and parameter values.
  It never sends command text.
- **No injection.** A value cannot add a line or a second command. Numbers are range-checked, choices
  and maps are checked against their lists. A template itself must be a single line per step.
- **Defining ≈ raw RCON.** Whoever can define a function can make the bot send any command, so
  `functions.manage` is treated like `rcon`: owner-only grant, refused from anyone else (see
  `admins` routes and their specs for `rcon`).
- **Running is separate.** `functions.run` is an ordinary staff permission. A function may also
  require a stricter existing permission (`kick`, `maps`, …), and the caller needs both.
- **Dangerous flag** forces a confirm dialog in the UI.
- **Audit.** Every run writes an audit row (`source: miniapp`) with the function id and slug, the
  parameters and the resolved commands. Definition create/update/delete are audited too.
- **Limits:** steps per function, command length, functions per instance, parameters per function.
- **Disabled** functions are hidden and rejected by the run route.

## 4. Data model

New table `custom_functions` in `packages/admin-store` (Drizzle migration; mind the migration-number
clash noted for the watch branch when merging):

| Column | Notes |
|---|---|
| `id` | uuid |
| `slug` | unique, URL-safe |
| `title`, `description`, `icon` | UI |
| `kind` | `action` / `player_action` / `setting` |
| `definition` | jsonb: `params[]`, `steps[]`, or the setting's `cvar` and control |
| `server_alias` | nullable: `null` = every server |
| `requires` | nullable permission the caller needs besides `functions.run` |
| `dangerous`, `enabled` | booleans |
| `created_by`, `created_at`, `updated_at` | |

`definition` is validated by a shared schema on write **and** again on run, so a bad row can never
reach RCON.

## 5. Contract and routes

- Types go in `apps/gateway/src/miniapp/api-types.ts`: `CustomFunctionDto`, `FunctionParam`,
  `SaveFunctionRequest`, `RunFunctionRequest`, `RunFunctionResponse` (`output`, per step).
- New `apps/gateway/src/miniapp/routes-functions.ts`:
  - `GET /functions` — what the caller may see; the editor view needs `functions.manage`
  - `POST /functions`, `PUT /functions/:id`, `DELETE /functions/:id` — `functions.manage`
  - `POST /functions/preview` — takes a draft plus sample values and returns the resolved commands without sending anything (so the editor can preview before saving)
  - `GET /servers/:server/functions` — what applies to this server
  - `POST /servers/:server/functions/:id/run` — `functions.run` plus `requires`; a `dangerous` function is refused unless the body has `confirm: true`
- New permissions `functions.manage` and `functions.run`: add to `PERMISSIONS` in both
  `api-types.ts` and `@cod2admin/admin-store`, update the permissions migration and its spec, and
  add `functions.manage` to the owner-only-grant set next to `rcon`.

## 6. Mini App UI (`apps/miniapp-web`)

- **Manage → Custom functions** (needs `functions.manage`): list, and a form builder with parameter
  rows, step rows, a live preview of the resolved command, and a **test run** against a chosen server.
- **Server page:** Action buttons grouped under "Custom". A parameter form opens in a sheet.
- **Players:** Player actions in the row menu.
- **Settings:** controls show the current value read from the server; saving writes it.
- Functions the caller can't run are not shown.

## 6.1 Example

Mod adds `scr_give <slot> <weapon>`. The owner creates a Player action:
`title: Give weapon`, `params: weapon (choice: ak47, m1garand, …)`, `steps: scr_give {player} {weapon}`,
`requires: kick`. Admins with `functions.run` + `kick` see "Give weapon" on every player row.

## 7. Testing

- Unit: template resolution and every parameter type, rejection of injection attempts (CR/LF, `;`,
  quotes, out-of-range, unknown choice), CP1251 text, definition schema validation.
- Route specs (pattern of `routes-management.spec.ts`): permission matrix, owner-only grant of
  `functions.manage`, audit rows, disabled and server-scoped functions.
- Dev loop: use the dev CoD2 server on the NAS; never start a second gateway with the shared bot token.

## 8. Phases

1. **F1 — Backend:** store and migration, schema, permissions, CRUD, preview and run routes, audit,
   unit and route specs.
2. **F2 — Editor and server actions:** the Manage page and Action buttons.
3. **F3 — Player actions and Settings:** the row menu and cvar-backed controls.
4. **F4 — Extras:** JSON import/export (starter packs per mod), docs, update `PLAN-miniapp.md` §0
   and the `-ru` summaries.

## 9. Out of scope / later

- Telegram `/run`.
- Parsing RCON replies (extracting values, result tables).
- Scheduled or event-triggered functions.
- Conditionals or loops inside a function.

## 10. F1 as built (2026-11-18)

- Code: `apps/gateway/src/lib/custom-functions.ts` (validation and resolution, pure),
  `apps/gateway/src/miniapp/routes-functions.ts`, table `custom_functions` (`0012_custom_functions`).
- **Quoting.** `text` values are inserted already quoted (`say {msg}` → `say "…"`); a template that
  writes `"{msg}"` is rejected. `choice`/`bool`/`map` values are single tokens (`[\w.:+-]`, up to 64)
  and `number`s are range-checked, so none needs quotes. A `player` value is `{ num, name }`, checked
  against live `status`, and becomes the slot number.
- **`;` is rejected in templates**, not just in values, and any step naming `rcon_password` is refused.
  Limits: 8 parameters, 5 steps, 512 characters per command, 100 functions.
- **Definitions are re-validated on every run**, so a hand-edited row can't reach RCON.
- **A run is audited even when a later step fails** (`functionrun`, with the commands that were
  actually sent and how many were planned). Other audit actions: `functioncreate`, `functionupdate`,
  `functiondelete`.
- **Hidden = missing.** A disabled function, one for another server, or one needing a permission the
  caller lacks answers 404 on run, same as an unknown id.
- **Not exposed to AI connections (MCP):** the new permissions are not in `MCP_PERMISSIONS`.
- Settings are written through `setCvar`; reading a setting's current value is F3.
- Not done in F1: the Mini App UI (F2/F3) and import/export (F4).

## 11. F2 as built (2026-11-18)

- **Editor:** `apps/miniapp-web/src/app/pages/functions/functions.ts`, route `/functions` (needs
  `functions.manage`), linked from *More → Custom functions*. A list, and a form for title, id (set
  from the title, fixed after creation), description, server scope, who may run it, dangerous and
  enabled flags, parameters, and 1–5 steps. "Try it" calls `POST /functions/preview` and shows the
  commands without sending anything.
- **Buttons:** `shared/custom-actions.ts`, a "Custom" card on the dashboard for anyone with
  `functions.run`. A tap with parameters opens a form (player and map pickers use live
  status and the installed-maps list), a dangerous function asks for confirmation first, and the
  steps' output is shown under the buttons.
- **Scope:** F2 created and edited only `action` functions; F3 added the other two kinds (§12).
- Choice options are typed one per line as `value label`.
- A player parameter can't be previewed in the editor (it needs a live player); try it on the dashboard.
- Russian texts added to `i18n-ru.ts` (the template-text spec enforces them).
- **Not verified in a real browser:** build, typecheck and unit tests pass, but the pages have not been
  looked at yet.

## 12. F3 as built (2026-11-18)

- **Player actions:** the player sheet (tap a player) shows a button per `player_action` the caller may
  run on this server. The slot and name are sent as `player`; the gateway checks the slot still holds
  that name. Questions other than `player` are asked in a form first.
- **Settings:** a "Custom settings" card on the dashboard. A toggle or choice applies at once; a
  number or text has a **Set** button. The control shows the server's current value.
- **Reading a value:** new `GET /servers/:server/functions/values` (needs `functions.run`) asks the
  server for each visible setting's cvar by name (`parseCvarReply` reads `"x" is:"v^7" default:…`).
  The public `getstatus` isn't used: it lists only serverinfo cvars, and a mod's often aren't. A cvar
  the server doesn't answer for shows as "didn't say" instead of a wrong value.
- **Editor:** now offers all three kinds. A setting is a cvar plus how it's shown (on/off with the
  values it writes, number with a range, choice, text). "Try it" previews a setting's value too;
  anything needing a player is previewed on the dashboard or sheet after saving.
- Both the dashboard card and the player sheet use one `FunctionRunner` service (asks, confirms a
  dangerous function, sends, reports), so the two behave alike.
- **Still not verified in a real browser** (see §11); build, typecheck and the unit tests pass.

## 13. F4 as built (2026-11-18)

- **Pack format:** `{ "format": "cod2admin-functions", "version": 1, "functions": [ … ] }`, each entry
  the same shape the editor saves (`SaveFunctionRequest`: no id, creator or dates). A bare list is
  accepted too. `docs/examples/custom-functions.json` is a three-function example; a spec keeps it valid.
- **Export:** *More → Custom functions → Export* shows the JSON for the functions you tick, with a
  Copy button. It is text on screen, not a file download, because downloads are unreliable inside
  Telegram's WebView.
- **Import:** paste the JSON or pick its file, press **Check**, read what each function would send,
  then **Import**. `POST /functions/import` (needs `functions.manage`):
  - `dryRun` reports what would happen and saves nothing; the UI always does this first.
  - Every entry goes through the same validation as one made by hand, and **nothing is saved unless
    all of them pass** — a pack is one unit. The error names the function.
  - A function whose id exists is kept (`skip`, the default) or replaced (`onConflict: "replace"`).
  - A function scoped to a server that doesn't exist here is imported for all servers, with a note.
  - At most 50 functions per pack, and the 100-function limit still holds.
  - The import is one audit row (`functionimport`) with the definitions that were saved.
- A pack is code the owner's server will run, so the import screen shows every step before saving;
  there is no auto-import and nothing is fetched from a URL.
- Still open (not planned): Telegram `/run`, parsing RCON replies, scheduled functions (§9).
