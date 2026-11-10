import {
  effectivePermissions,
  isPermission,
  type Permission,
} from '@cod2admin/admin-store';

/**
 * Permissions an AI connection can be given. Anything else the person holds stays in Telegram:
 * replacing the bot, moving its Telegram route, adding a server password, or changing who is staff
 * would let a prompt-injected model widen its own access.
 */
export const MCP_PERMISSIONS = [
  'kick',
  'tempban',
  'ban',
  'say',
  'maps',
  'cvars.read',
  'cvars.write',
  'servers.view',
  'servers.assign',
  'audit',
  'rcon',
] as const satisfies readonly Permission[];

const MCP_PERMISSION_SET = new Set<string>(MCP_PERMISSIONS);

export function isMcpPermission(value: string): value is Permission {
  return MCP_PERMISSION_SET.has(value);
}

export interface ParsedScope {
  /** Empty when the app asked only to read. */
  permissions: Permission[];
  /** The scope string stored on the request, always including `read`. */
  scope: string;
}

/**
 * What the app asked for. An omitted scope is read-only: a client must name each action.
 * Unknown ids are rejected rather than ignored, so a typo cannot look like a smaller grant.
 */
export function parseScope(scope: string | undefined): ParsedScope | string {
  const tokens = (scope ?? '').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { permissions: [], scope: 'read' };
  }
  const permissions: Permission[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token === 'read' || seen.has(token)) {
      seen.add(token);
      continue;
    }
    if (!isPermission(token) || !isMcpPermission(token)) {
      return `Unknown scope: ${token}`;
    }
    seen.add(token);
    permissions.push(token);
  }
  return {
    permissions,
    scope: ['read', ...permissions].join(' '),
  };
}

/** The permissions this person can actually hand this app, in catalog order. */
export function grantablePermissions(
  actor: { isOwner: boolean; permissions: readonly Permission[] },
  requested: readonly Permission[],
): Permission[] {
  const held = new Set(effectivePermissions(actor));
  return requested.filter((id) => held.has(id));
}

/** Live permissions of a connection: the snapshot, minus anything the person has since lost. */
export function connectionPermissions(
  actor: { isOwner: boolean; permissions: readonly Permission[] },
  granted: readonly string[],
): Permission[] {
  const held = new Set(effectivePermissions(actor));
  const allowed: Permission[] = [];
  for (const id of granted) {
    if (isMcpPermission(id) && held.has(id) && !allowed.includes(id)) {
      allowed.push(id);
    }
  }
  return allowed;
}

export function scopeFromPermissions(
  permissions: readonly Permission[],
): string {
  return ['read', ...permissions].join(' ');
}

/**
 * Actions that must not share a session with raw chat text. `say` is absent on purpose: the
 * chat watcher is allowed to speak, and nothing else.
 */
const CHAT_HIDDEN_BY = new Set<Permission>([
  'kick',
  'tempban',
  'ban',
  'maps',
  'cvars.write',
  'servers.assign',
  'rcon',
]);

/** Raw in-game chat is visible only when this connection cannot act beyond `say`. */
export function seesChat(permissions: readonly Permission[]): boolean {
  return !permissions.some((id) => CHAT_HIDDEN_BY.has(id));
}
