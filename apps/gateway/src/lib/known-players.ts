import type { AdminStore, KnownPlayer } from '@cod2admin/admin-store';
import type { RconClient, StatusPlayer } from '@cod2admin/rcon-client';
import type { ChatTemplates } from './chat-templates.js';
import { displayName } from './commands/players.js';
import { sanitizeRconArg } from './sanitize.js';

/**
 * Known players (docs/PLAN-known-players.md): a nickname plus the provider networks (ASNs) it
 * normally connects from. A player with a known name from one of those ASNs is never kicked for a
 * VPN (vpn-kick.ts); a player using a known name from any other ASN is kicked on sight — kick
 * only, never a ban, since the real owner may be on a new ISP and an admin can then add the ASN.
 * Explicit bans and mutes are not affected: they are deliberate admin decisions.
 *
 * Off until `/known on`, like `/vpnkick`, so a fresh list can't kick anyone before it's reviewed.
 */

/** Where `/known on|off` keeps its state (admin-store settings), as `{ enabled: boolean }`. */
export const KNOWN_PLAYERS_SETTING_KEY = 'known.enabled';

export function parseKnownEnabled(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { enabled?: unknown }).enabled === true
  );
}

/** How a name is stored and matched: colour codes stripped, lower case — as `/vpnkick allow`. */
export function normalizeKnownName(name: string): string {
  return displayName({ num: 0, score: 0, ping: 0, name }).toLowerCase();
}

/**
 * - `unknown`: the name isn't in the list — not our business.
 * - `known`: the name is listed and the player's ASN is one of its ASNs.
 * - `unverified`: the name is listed but the ASN can't be determined (database not loaded, LAN
 *   address, a bot). Treated as known — missing data never kicks a legitimate player.
 * - `impostor`: the name is listed and the ASN is not one of its ASNs.
 */
export type KnownVerdict = 'unknown' | 'known' | 'unverified' | 'impostor';

export function classify(
  player: StatusPlayer,
  entries: ReadonlyMap<string, ReadonlySet<number>>,
  asnOf: (ip: string) => number | undefined,
): KnownVerdict {
  const asns = entries.get(normalizeKnownName(player.name));
  if (!asns) {
    return 'unknown';
  }
  const asn = player.ip ? asnOf(player.ip) : undefined;
  if (asn === undefined) {
    return 'unverified';
  }
  return asns.has(asn) ? 'known' : 'impostor';
}

/** Audit and game-chat line at most once per name+IP in this window; the kick happens every sweep. */
const ANNOUNCE_EVERY_MS = 5 * 60 * 1000;

export interface KnownSweepDeps {
  rconClients: Map<string, RconClient>;
  adminStore: Pick<AdminStore, 'recordAuditLog'>;
  chatTemplates: ChatTemplates;
}

/** The live known-players list plus the sweep that enforces it. One per gateway. */
export class KnownPlayers {
  private enabledNow = false;
  private list: KnownPlayer[] = [];
  private byName: ReadonlyMap<string, ReadonlySet<number>> = new Map();
  private readonly lastAnnounced = new Map<string, number>();

  constructor(
    private readonly asnOf: (ip: string) => number | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get enabled(): boolean {
    return this.enabledNow;
  }

  setEnabled(enabled: boolean): void {
    this.enabledNow = enabled;
  }

  get entries(): readonly KnownPlayer[] {
    return this.list;
  }

  setEntries(entries: KnownPlayer[]): void {
    this.list = [...entries];
    this.byName = new Map(
      entries.map((entry) => [entry.name, new Set(entry.asns)]),
    );
  }

  /** The verdict for a player, whether or not the feature is on (`/players` shows it either way). */
  verdict(player: StatusPlayer): KnownVerdict {
    return classify(player, this.byName, this.asnOf);
  }

  /** True while on, for a listed name that isn't an impostor — exempt from `/vpnkick`. */
  isProtected(player: StatusPlayer): boolean {
    if (!this.enabledNow) {
      return false;
    }
    const verdict = this.verdict(player);
    return verdict === 'known' || verdict === 'unverified';
  }

  /** One pass over every server. A server that fails is logged and skipped, like the ban sweep. */
  async sweep(deps: KnownSweepDeps): Promise<void> {
    if (!this.enabledNow || this.list.length === 0) {
      return;
    }
    for (const [key, at] of this.lastAnnounced) {
      if (this.now() - at >= ANNOUNCE_EVERY_MS) {
        this.lastAnnounced.delete(key);
      }
    }
    for (const [serverAlias, rcon] of deps.rconClients) {
      try {
        const { players } = await rcon.status();
        for (const player of players) {
          if (this.verdict(player) === 'impostor') {
            await this.kick(deps, serverAlias, rcon, player);
          }
        }
      } catch (error) {
        console.error(
          `Known players sweep failed for server "${serverAlias}":`,
          error,
        );
      }
    }
  }

  private async kick(
    deps: KnownSweepDeps,
    serverAlias: string,
    rcon: RconClient,
    player: StatusPlayer,
  ): Promise<void> {
    const name = displayName(player);
    const key = `${serverAlias}|${normalizeKnownName(player.name)}|${player.ip}`;
    const last = this.lastAnnounced.get(key);
    const announce =
      last === undefined || this.now() - last >= ANNOUNCE_EVERY_MS;
    if (announce) {
      this.lastAnnounced.set(key, this.now());
      const text = deps.chatTemplates.render('known_kick', { name });
      if (text) {
        await rcon.say(text);
      }
    }
    await rcon.kick(player.num, sanitizeRconArg(player.name));
    if (announce) {
      await deps.adminStore.recordAuditLog({
        actorTelegramId: 0,
        action: 'known_kick',
        target: name,
        serverAlias,
        source: 'auto',
        detailJson: {
          ip: player.ip ?? null,
          asn: player.ip ? (this.asnOf(player.ip) ?? null) : null,
        },
      });
    }
  }
}
