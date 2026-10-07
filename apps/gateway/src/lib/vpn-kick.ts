import type { AdminStore } from '@cod2admin/admin-store';
import type { RconClient, StatusPlayer } from '@cod2admin/rcon-client';
import { displayName } from './commands/players.js';
import { sanitizeRconArg } from './sanitize.js';
import type { VpnKind, VpnLookup } from './vpn-ranges.js';

/**
 * Optional kick-on-sight for players flagged as VPN/proxy/Tor/hosting (vpn-ranges.ts), turned on
 * with `/vpnkick on`. Kick only, never a ban: a VPN exit IP is shared by strangers, and the player
 * can come back with the VPN off. Runs on the ban sweep's interval (expiry-poller.ts), and only
 * queries servers while it's on.
 *
 * Added 2026-10-07 after the owner joined CTF RUSSIA through two different VPNs (AS202226, then
 * AS58061 "Scalaxy B.V.") that no downloaded list caught — so `/vpnnets` matters for this too.
 */

/** Where `/vpnkick` keeps its state (admin-store settings). */
export const VPN_KICK_SETTING_KEY = 'vpn.kick';

export interface VpnKickSettings {
  enabled: boolean;
  /** Players never kicked for a VPN: a real GUID, or a name (lower case, colour codes stripped). */
  exempt: string[];
}

export const DEFAULT_VPN_KICK_SETTINGS: VpnKickSettings = { enabled: false, exempt: [] };

export function parseVpnKickSettings(value: unknown): VpnKickSettings {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_VPN_KICK_SETTINGS };
  }
  const { enabled, exempt } = value as { enabled?: unknown; exempt?: unknown };
  return {
    enabled: enabled === true,
    exempt: Array.isArray(exempt) ? exempt.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [],
  };
}

/** How an exempt entry is stored: a GUID as-is, a name lower-cased with colour codes stripped. */
export function normalizeExempt(value: string): string {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : displayName({ num: 0, score: 0, ping: 0, name: trimmed }).toLowerCase();
}

function isExempt(player: StatusPlayer, exempt: ReadonlySet<string>): boolean {
  if (player.guid && player.guid !== '0' && exempt.has(player.guid)) {
    return true;
  }
  return exempt.has(displayName(player).toLowerCase());
}

/** Announce in game chat and audit at most once per player IP in this window; kick every time. */
const ANNOUNCE_EVERY_MS = 5 * 60 * 1000;

const KIND_TEXT: Record<VpnKind, string> = {
  tor: 'Tor',
  vpn: 'VPN',
  provider: 'VPN',
  hosting: 'VPN/proxy',
};

export interface VpnKickSweepDeps {
  vpn: VpnLookup;
  rconClients: Map<string, RconClient>;
  adminStore: Pick<AdminStore, 'recordAuditLog'>;
}

/** The live `/vpnkick` state plus the sweep that enforces it. One per gateway. */
export class VpnKicker {
  private current: VpnKickSettings = { ...DEFAULT_VPN_KICK_SETTINGS };
  private exemptSet: ReadonlySet<string> = new Set();
  private readonly lastAnnounced = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get settings(): VpnKickSettings {
    return { enabled: this.current.enabled, exempt: [...this.current.exempt] };
  }

  setSettings(settings: VpnKickSettings): void {
    this.current = { enabled: settings.enabled, exempt: [...settings.exempt] };
    this.exemptSet = new Set(settings.exempt);
  }

  /** One pass over every server. A server that fails is logged and skipped, like the ban sweep. */
  async sweep(deps: VpnKickSweepDeps): Promise<void> {
    if (!this.current.enabled) {
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
          const kind = player.ip ? deps.vpn.lookup(player.ip) : undefined;
          if (!kind || isExempt(player, this.exemptSet)) {
            continue;
          }
          await this.kick(deps, serverAlias, rcon, player, kind);
        }
      } catch (error) {
        console.error(`VPN kick sweep failed for server "${serverAlias}":`, error);
      }
    }
  }

  private async kick(
    deps: VpnKickSweepDeps,
    serverAlias: string,
    rcon: RconClient,
    player: StatusPlayer,
    kind: VpnKind,
  ): Promise<void> {
    const name = displayName(player);
    const key = `${serverAlias}|${player.ip}`;
    const last = this.lastAnnounced.get(key);
    const announce = last === undefined || this.now() - last >= ANNOUNCE_EVERY_MS;
    if (announce) {
      this.lastAnnounced.set(key, this.now());
      await rcon.say(sanitizeRconArg(`${name} kicked: ${KIND_TEXT[kind]} is not allowed here. Turn it off to play.`));
    }
    await rcon.kick(sanitizeRconArg(player.name));
    if (announce) {
      await deps.adminStore.recordAuditLog({
        actorTelegramId: 0,
        action: 'vpn_kick',
        target: name,
        serverAlias,
        source: 'auto',
        detailJson: { ip: player.ip, guid: player.guid ?? null, kind },
      });
    }
  }
}
