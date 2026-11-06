import type { AdminStore, AuditSource } from '@cod2admin/admin-store';
import type { BanStore } from '@cod2admin/ban-store';
import { isBanFileSafeName, type RconClient } from '@cod2admin/rcon-client';
import { broadcastModerationAction } from './broadcast.js';
import { sanitizeRconArg } from './sanitize.js';

export type ModerationActionKind = 'kick' | 'ban' | 'tempban';

export interface ModerationTarget {
  num: number;
  name: string;
  /** `undefined`/`'0'` means no valid GUID (docs/PLAN.md §2.4) — triggers the IP-ban fallback for ban/tempban. */
  guid?: string | null;
  ip?: string;
}

export interface ExecuteModerationActionOptions {
  serverAlias: string;
  rcon: RconClient;
  banStore: BanStore;
  adminStore: AdminStore;
  actorTelegramId: number;
  reason?: string | null;
  source: AuditSource;
  /** Only meaningful for `kind: 'tempban'`. Default 30 minutes (docs/PLAN.md §5 step 6). */
  durationMs?: number;
}

export interface ModerationActionResult {
  /** Human label for what actually happened, e.g. `"Banned"` or `"IP-banned (GUID unavailable)"`. */
  label: string;
  ipFallback: boolean;
  durationMs?: number;
}

/** Thrown when neither a usable GUID nor an IP is available — nothing left to ban by. */
export class ModerationActionError extends Error {}

const DEFAULT_TEMPBAN_MS = 30 * 60_000;

/**
 * `clientkick` by the status slot. A negative `num` is a name-only `/kick` (the player was not
 * on the list we just read), which has to go through `kick <name>`.
 */
function dropPlayer(rcon: RconClient, target: ModerationTarget): Promise<string> {
  if (target.num >= 0) {
    return rcon.kick(target.num, target.name);
  }
  return rcon.kick(target.name);
}

function hasUsableGuid(guid: string | null | undefined): guid is string {
  return !!guid && guid !== '0';
}

/**
 * The shared kick/ban/tempban logic behind both the `/kick`, `/ban`, `/tempban` commands and the
 * report card's buttons (docs/PLAN.md §5 step 6) — one place implementing the GUID-vs-IP
 * branching (§5 step 7) so both call paths ban the same target the same way. Handles the rcon
 * call, the `ban-store`/`admin-store` writes, and the moderation broadcast; callers own their own
 * reply/message formatting.
 */
export async function executeModerationAction(
  kind: ModerationActionKind,
  target: ModerationTarget,
  options: ExecuteModerationActionOptions,
): Promise<ModerationActionResult> {
  const reason = options.reason ? sanitizeRconArg(options.reason) : null;

  async function recordAudit(
    action: string,
    detailJson?: Record<string, unknown>,
  ): Promise<void> {
    await options.adminStore.recordAuditLog({
      actorTelegramId: options.actorTelegramId,
      action,
      target: target.name,
      serverAlias: options.serverAlias,
      reason,
      source: options.source,
      detailJson,
    });
  }

  if (kind === 'kick') {
    await dropPlayer(options.rcon, target);
    await broadcastModerationAction(options.rcon, target.name, 'kicked');
    await recordAudit('kick');
    return { label: 'Kicked', ipFallback: false };
  }

  const durationMs = options.durationMs ?? DEFAULT_TEMPBAN_MS;
  const expiresAt =
    kind === 'tempban' ? new Date(Date.now() + durationMs) : null;

  if (hasUsableGuid(target.guid)) {
    // Only a permanent ban goes into ban.txt, and only when `unbanUser` can take it back out
    // again later (docs/PLAN.md §2.4 "ban.txt"). Everything else is just kicked here and kept
    // out by the poller's GUID sweep, the same way bans are already enforced on other servers.
    // Any reply from `banClient` means it may not have dropped the player (e.g. "already banned"),
    // so they're kicked too; a kick for a player who's already gone does no harm.
    const bannedNatively =
      kind === 'ban' &&
      isBanFileSafeName(target.name) &&
      !(await options.rcon.banClient(target.num)).trim();
    if (!bannedNatively) {
      await dropPlayer(options.rcon, target);
    }
    await options.banStore.recordBan({
      serverAlias: options.serverAlias,
      name: target.name,
      guid: target.guid,
      reason,
      bannedBy: options.actorTelegramId,
      expiresAt,
    });
    const label = kind === 'tempban' ? 'Temp-banned' : 'Banned';
    // Broadcast uses a plain player-facing verb, not the (admin-facing) detailed label below —
    // players don't need "GUID unavailable" jargon in an in-game chat announcement.
    await broadcastModerationAction(
      options.rcon,
      target.name,
      kind === 'tempban' ? 'temp-banned' : 'banned',
    );
    await recordAudit(kind, { guid: target.guid });
    return {
      label,
      ipFallback: false,
      durationMs: kind === 'tempban' ? durationMs : undefined,
    };
  }

  // GUID-0/unknown fallback (docs/PLAN.md §2.4/§5 step 7): the game binary can't ban by IP
  // natively, so kick immediately and let the poller enforce the IP block going forward.
  if (!target.ip) {
    throw new ModerationActionError(
      `Cannot ${kind} ${target.name}: no GUID and no known IP to fall back to.`,
    );
  }
  await dropPlayer(options.rcon, target);
  await options.banStore.recordIpBan({
    serverAlias: options.serverAlias,
    ip: target.ip,
    name: target.name,
    reason,
    bannedBy: options.actorTelegramId,
    expiresAt,
  });
  const label =
    kind === 'tempban'
      ? 'IP temp-banned (GUID unavailable)'
      : 'IP-banned (GUID unavailable)';
  await broadcastModerationAction(
    options.rcon,
    target.name,
    kind === 'tempban' ? 'temp-banned' : 'banned',
  );
  await recordAudit(kind, { ip: target.ip });
  return {
    label,
    ipFallback: true,
    durationMs: kind === 'tempban' ? durationMs : undefined,
  };
}
