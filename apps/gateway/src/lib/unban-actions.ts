import type { AuditSource } from '@cod2admin/admin-store';
import { isBanFileSafeName } from '@cod2admin/rcon-client';
import type { GatewayDeps } from './deps.js';

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** How much of a GUID's ban history to look through for `ban.txt` entries to remove. */
const BAN_HISTORY_LIMIT = 50;

export function isIpv4(value: string): boolean {
  return IPV4_PATTERN.test(value) && value.split('.').every((octet) => Number(octet) <= 255);
}

export interface LiftBanResult {
  /** Whether the target was an IP (else a GUID). */
  ip: boolean;
  /** How many bans still in effect were lifted. */
  lifted: number;
  /** Servers that didn't answer `unbanUser`, so their `ban.txt` may still block the player. */
  unanswered: string[];
  /** `server (name)` pairs whose `ban.txt` had no entry to remove for a ban lifted now. */
  notFound: string[];
}

/**
 * Lifts every ban on a GUID or IP, on every server, and audit-logs it — shared by `/unban` and
 * the Mini App (docs/PLAN.md §6, docs/PLAN-miniapp.md §6.3).
 *
 * An IP target only ever lives in `ban_ips` (§7 — never written to `ban.txt`), so stamping
 * `unbannedAt` is enough for the poller to stop enforcing it. So is a GUID temp ban. A permanent
 * GUID ban may also be in its issuing server's `ban.txt`, and `unbanUser` removes those by player
 * **name**, not GUID (§2.4 "ban.txt"), so each server that issued one is asked to remove the
 * name it was recorded under. That list comes from the GUID's whole ban history, not just the
 * bans lifted now, so lifting again retries a server that didn't answer the first time.
 */
export async function liftBan(
  target: string,
  deps: Pick<GatewayDeps, 'banStore' | 'adminStore' | 'rconClients'>,
  actor: { telegramId: number; source: AuditSource },
): Promise<LiftBanResult> {
  const ip = isIpv4(target);
  const unanswered: string[] = [];
  const notFound: string[] = [];
  let lifted: number;

  if (ip) {
    lifted = await deps.banStore.unbanIp(target);
  } else {
    const history = await deps.banStore.listBansByGuid(target, BAN_HISTORY_LIMIT);
    const liftedBans = await deps.banStore.unbanByGuid(target);
    lifted = liftedBans.length;
    const liftedIds = new Set(liftedBans.map((ban) => ban.id));

    // One `unbanUser` per server and name — only permanent bans issued under a name that was
    // safe to write to ban.txt can be in there (see moderation-actions.ts).
    const entries = new Map<string, { serverAlias: string; name: string; liftedNow: boolean }>();
    for (const ban of history) {
      if (ban.expiresAt !== null || !isBanFileSafeName(ban.name) || !deps.rconClients.has(ban.serverAlias)) {
        continue;
      }
      const key = `${ban.serverAlias}\n${ban.name}`;
      const entry = entries.get(key) ?? { serverAlias: ban.serverAlias, name: ban.name, liftedNow: false };
      entry.liftedNow ||= liftedIds.has(ban.id);
      entries.set(key, entry);
    }

    const pending = [...entries.values()];
    const results = await Promise.allSettled(
      pending.map(({ serverAlias, name }) => deps.rconClients.get(serverAlias)!.unbanUser(name)),
    );
    results.forEach((result, i) => {
      const { serverAlias, name, liftedNow } = pending[i];
      if (result.status === 'rejected') {
        unanswered.push(serverAlias);
      } else if (result.value === 0 && liftedNow) {
        notFound.push(`${serverAlias} (${name})`);
      }
    });
  }

  await deps.adminStore.recordAuditLog({
    actorTelegramId: actor.telegramId,
    action: 'unban',
    target,
    serverAlias: null,
    source: actor.source,
    detailJson: {
      lifted,
      ...(unanswered.length > 0 ? { unanswered } : {}),
      ...(notFound.length > 0 ? { notFound } : {}),
    },
  });

  return { ip, lifted, unanswered: [...new Set(unanswered)], notFound };
}
