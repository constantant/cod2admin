import type { AuditSource, RecordAuditLogInput } from '@cod2admin/admin-store';
import type { BanStore } from '@cod2admin/ban-store';
import {
  isBanFileSafeName,
  UNKNOWN_COMMAND_PATTERN,
  type RconClient,
} from '@cod2admin/rcon-client';
import { broadcastModerationAction } from './broadcast.js';
import {
  DEFAULT_CHAT_TEMPLATES,
  type ChatTemplates,
  type ChatTemplateId,
} from './chat-templates.js';
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
  rcon: Pick<RconClient, 'kick' | 'say' | 'banClient'>;
  banStore: BanStore;
  adminStore: {
    recordAuditLog(entry: RecordAuditLogInput): Promise<unknown>;
  };
  actorTelegramId: number;
  reason?: string | null;
  source: AuditSource;
  /** Only meaningful for `kind: 'tempban'`. Default 30 minutes (docs/PLAN.md §5 step 6). */
  durationMs?: number;
  /** Merged into every audit row, for example the AI connection that asked. */
  detailJson?: Record<string, unknown>;
  /** The live game-chat lines. Absent in a test: the built-in text. */
  chatTemplates?: ChatTemplates;
  /** Audit `action`. Defaults to the kind, so `/kick` stays `kick`. */
  auditAction?: string;
  /** Game-chat line for a kick. Defaults to the human kick line. */
  chatTemplateId?: ChatTemplateId;
  /**
   * Watch only. One `clientkick <slot>`. An unknown command is not a kick:
   * no chat line and no audit.
   */
  slotOnly?: boolean;
  /**
   * After the player is dropped and before the audit. Watch stores evidence
   * here so the id is on the audit, and skips it when `clientkick` is unknown.
   */
  beforeAudit?: () => Promise<Record<string, unknown> | void>;
}

export interface ModerationActionResult {
  /** Human label for what actually happened, e.g. `"Banned"` or `"IP-banned (GUID unavailable)"`. */
  label: string;
  ipFallback: boolean;
  durationMs?: number;
  /** `slotOnly` and the server has no `clientkick`. Nothing else was sent. */
  unknownCommand?: boolean;
}

/** Thrown when neither a usable GUID nor an IP is available — nothing left to ban by. */
export class ModerationActionError extends Error {}

const DEFAULT_TEMPBAN_MS = 30 * 60_000;

function announcement(
  options: ExecuteModerationActionOptions,
  id: ChatTemplateId,
): string {
  return options.chatTemplates?.get(id) ?? DEFAULT_CHAT_TEMPLATES[id];
}

/**
 * `clientkick` by the status slot. A negative `num` is a name-only `/kick` (the player was not
 * on the list we just read), which has to go through `kick <name>`.
 */
function dropPlayer(
  rcon: Pick<RconClient, 'kick'>,
  target: ModerationTarget,
  slotOnly: boolean,
): Promise<string> {
  if (target.num >= 0) {
    if (slotOnly) {
      // `kick <slot>` does not drop the player, and the slot may have been reused.
      return rcon.kick(target.num, undefined, { slotOnly: true });
    }
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
      detailJson: { ...options.detailJson, ...detailJson },
    });
  }

  const durationMs = options.durationMs ?? DEFAULT_TEMPBAN_MS;
  const minutes =
    kind === 'tempban' ? String(Math.round(durationMs / 60_000)) : '';
  const say = (id: ChatTemplateId) =>
    broadcastModerationAction(options.rcon, announcement(options, id), {
      name: target.name,
      reason: reason ?? '',
      minutes,
    });

  if (kind === 'kick') {
    const reply = await dropPlayer(
      options.rcon,
      target,
      options.slotOnly === true,
    );
    if (options.slotOnly && UNKNOWN_COMMAND_PATTERN.test(reply)) {
      return { label: 'Not kicked', ipFallback: false, unknownCommand: true };
    }
    await say(options.chatTemplateId ?? 'kick');
    const extra = options.beforeAudit ? await options.beforeAudit() : undefined;
    await recordAudit(
      options.auditAction ?? 'kick',
      extra && typeof extra === 'object' ? extra : undefined,
    );
    return { label: 'Kicked', ipFallback: false };
  }

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
      await dropPlayer(options.rcon, target, false);
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
    await say(kind);
    await recordAudit(options.auditAction ?? kind, { guid: target.guid });
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
  await dropPlayer(options.rcon, target, false);
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
  await say(kind);
  await recordAudit(options.auditAction ?? kind, { ip: target.ip });
  return {
    label,
    ipFallback: true,
    durationMs: kind === 'tempban' ? durationMs : undefined,
  };
}
