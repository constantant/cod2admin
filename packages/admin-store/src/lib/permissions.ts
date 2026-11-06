/**
 * What a staff member may do. These are not a rank: holding `ban` does not imply `maps`.
 * The owner (`admins.is_owner`) has every id, including ones added later, without stored rows.
 */
export const PERMISSIONS = [
  'kick',
  'tempban',
  'mute',
  'ban',
  'say',
  'maps',
  'presets',
  'vpn',
  'cvars.read',
  'cvars.write',
  'servers.view',
  'servers.assign',
  'servers.manage',
  'notes.manage',
  'admins.manage',
  'audit',
  'rcon',
  'update',
  'relays',
  'logs',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** What a moderator had before permissions: kick, temp-ban, mute. */
export const MODERATOR_PERMISSIONS = [
  'kick',
  'tempban',
  'mute',
] as const satisfies readonly Permission[];

/** What an admin had, on top of a moderator. Not a stored role — a checklist template. */
export const ADMIN_PERMISSIONS = [
  ...MODERATOR_PERMISSIONS,
  'ban',
  'say',
  'maps',
  'presets',
  'vpn',
  'cvars.read',
  'servers.view',
  'servers.assign',
  'notes.manage',
  'admins.manage',
] as const satisfies readonly Permission[];

/**
 * The owner may turn these on for someone. Holding one does not let that person
 * turn it on or off for anyone else.
 */
export const OWNER_GRANTED_PERMISSIONS = [
  'rcon',
  'update',
] as const satisfies readonly Permission[];

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function hasPermission(
  actor: { isOwner: boolean; permissions: readonly Permission[] },
  id: Permission,
): boolean {
  return actor.isOwner || actor.permissions.includes(id);
}

/** The ids this person can actually use. The owner gets the whole catalog. */
export function effectivePermissions(actor: {
  isOwner: boolean;
  permissions: readonly Permission[];
}): Permission[] {
  return actor.isOwner ? [...PERMISSIONS] : [...actor.permissions];
}

function uniquePermissions(values: readonly string[]): Permission[] {
  const seen = new Set<Permission>();
  for (const value of values) {
    if (!isPermission(value)) {
      throw new PermissionError(`Unknown permission: ${value}`);
    }
    seen.add(value);
  }
  return [...seen];
}

/**
 * The set to store after an edit.
 *
 * The owner may set any ids, including `rcon` and `update`. Anyone else may set
 * only ids they hold, and `rcon` / `update` stay exactly as they already are:
 * mentioning one the person doesn't have is refused, and leaving one out does
 * not take it away.
 */
export function resolvePermissionGrant(input: {
  actorIsOwner: boolean;
  actorPermissions: readonly Permission[];
  targetPermissions: readonly Permission[];
  requested: readonly string[];
}): Permission[] {
  const requested = uniquePermissions(input.requested);
  if (input.actorIsOwner) {
    return requested;
  }
  for (const id of requested) {
    if ((OWNER_GRANTED_PERMISSIONS as readonly string[]).includes(id)) {
      if (!input.targetPermissions.includes(id)) {
        throw new PermissionError(`Only the owner can grant ${id}.`);
      }
      continue;
    }
    if (!input.actorPermissions.includes(id)) {
      throw new PermissionError(`You can't grant ${id}.`);
    }
  }
  const sticky = OWNER_GRANTED_PERMISSIONS.filter((id) =>
    input.targetPermissions.includes(id),
  );
  return [
    ...requested.filter(
      (id) => !(OWNER_GRANTED_PERMISSIONS as readonly string[]).includes(id),
    ),
    ...sticky,
  ];
}
