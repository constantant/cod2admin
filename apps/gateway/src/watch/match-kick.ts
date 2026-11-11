import { stripColorCodes, type StatusPlayer } from '@cod2admin/rcon-client';
import type { WatchIdentityKind } from '@cod2admin/watch-store';

export type KickMatch =
  { ok: true; num: number; name: string } | { ok: false; reason: string };

export function watchIdentityKind(key: string): WatchIdentityKind | undefined {
  if (key.startsWith('hwid:') && key.length > 'hwid:'.length) {
    return 'hwid';
  }
  if (key.startsWith('guid:') && key.length > 'guid:'.length) {
    return 'guid';
  }
  if (key.startsWith('ip:') && key.length > 'ip:'.length) {
    return 'ip';
  }
  return undefined;
}

/**
 * One non-zero GUID row for `hwid:` and `guid:`. One IP row, and exactly one
 * name in 24h, for `ip:`. GUID 0 is not matched by IP. Two rows are not a guess.
 */
export function matchKickSlot(input: {
  kind: WatchIdentityKind;
  profileKey: string;
  lastGuid: string | null;
  distinctNames24h: number;
  players: readonly StatusPlayer[];
}): KickMatch {
  if (input.kind === 'hwid' || input.kind === 'guid') {
    const guid =
      input.kind === 'guid'
        ? input.profileKey.slice('guid:'.length)
        : input.lastGuid;
    if (!guid || guid === '0') {
      return { ok: false, reason: 'guid0' };
    }
    return oneRow(
      input.players.filter((row) => (row.guid ?? '').trim() === guid),
    );
  }
  if (input.distinctNames24h === 0) {
    return { ok: false, reason: 'no_name' };
  }
  if (input.distinctNames24h !== 1) {
    return { ok: false, reason: 'shared_ip' };
  }
  const ip = input.profileKey.slice('ip:'.length);
  return oneRow(input.players.filter((row) => (row.ip ?? '').trim() === ip));
}

function oneRow(rows: readonly StatusPlayer[]): KickMatch {
  const row = rows[0];
  if (!row || rows.length !== 1) {
    return {
      ok: false,
      reason: rows.length === 0 ? 'gone' : 'ambiguous_slot',
    };
  }
  return { ok: true, num: row.num, name: stripColorCodes(row.name).trim() };
}
