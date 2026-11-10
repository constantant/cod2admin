import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  OWNER_GRANTED_PERMISSIONS,
  PermissionError,
  effectivePermissions,
  hasPermission,
  resolvePermissionGrant,
} from './permissions.js';

const adminPerms = [...ADMIN_PERMISSIONS];

describe('resolvePermissionGrant', () => {
  it('lets the owner grant rcon and update', () => {
    expect(
      resolvePermissionGrant({
        actorIsOwner: true,
        actorPermissions: [],
        targetPermissions: ['kick'],
        requested: ['kick', 'rcon', 'update'],
      }),
    ).toEqual(['kick', 'rcon', 'update']);
  });

  it('lets the owner take rcon and update away', () => {
    expect(
      resolvePermissionGrant({
        actorIsOwner: true,
        actorPermissions: [],
        targetPermissions: ['kick', 'rcon', 'update'],
        requested: ['kick'],
      }),
    ).toEqual(['kick']);
  });

  it('refuses to pass rcon or update on, and leaves the ones already granted', () => {
    expect(() =>
      resolvePermissionGrant({
        actorIsOwner: false,
        actorPermissions: [...adminPerms, 'rcon', 'update'],
        targetPermissions: ['kick', 'rcon'],
        requested: ['kick', 'ban', 'update'],
      }),
    ).toThrow(PermissionError);

    expect(
      resolvePermissionGrant({
        actorIsOwner: false,
        actorPermissions: [...adminPerms, 'rcon'],
        targetPermissions: ['mute', 'rcon'],
        requested: ['kick', 'ban'],
      }),
    ).toEqual(['kick', 'ban', 'rcon']);
  });

  it('refuses a permission the actor does not hold', () => {
    expect(() =>
      resolvePermissionGrant({
        actorIsOwner: false,
        actorPermissions: ['kick', 'admins.manage'],
        targetPermissions: [],
        requested: ['ban'],
      }),
    ).toThrow(/can't grant ban/);
  });

  it('rejects an unknown id', () => {
    expect(() =>
      resolvePermissionGrant({
        actorIsOwner: true,
        actorPermissions: [],
        targetPermissions: [],
        requested: ['not-a-permission'],
      }),
    ).toThrow(PermissionError);
  });
});

describe('hasPermission', () => {
  it('treats the owner as holding rcon with no stored rows', () => {
    expect(hasPermission({ isOwner: true, permissions: [] }, 'rcon')).toBe(
      true,
    );
  });

  it('keeps watch.manage with the owner, not the admin template', () => {
    expect(OWNER_GRANTED_PERMISSIONS).toContain('watch.manage');
    expect(ADMIN_PERMISSIONS).not.toContain('watch.manage');
    expect(effectivePermissions({ isOwner: true, permissions: [] })).toContain(
      'watch.manage',
    );
    expect(
      effectivePermissions({
        isOwner: false,
        permissions: [...ADMIN_PERMISSIONS],
      }),
    ).not.toContain('watch.manage');
    expect(() =>
      resolvePermissionGrant({
        actorIsOwner: false,
        actorPermissions: [...adminPerms, 'watch.manage'],
        targetPermissions: ['kick'],
        requested: ['kick', 'watch.manage'],
      }),
    ).toThrow(/Only the owner can grant watch\.manage/);
    expect(
      resolvePermissionGrant({
        actorIsOwner: true,
        actorPermissions: [],
        targetPermissions: [],
        requested: ['watch.manage'],
      }),
    ).toEqual(['watch.manage']);
  });

  it('does not treat a moderator-shaped set as a ban', () => {
    expect(
      hasPermission(
        { isOwner: false, permissions: ['kick', 'tempban', 'mute'] },
        'ban',
      ),
    ).toBe(false);
    expect(
      OWNER_GRANTED_PERMISSIONS.includes('rcon') &&
        OWNER_GRANTED_PERMISSIONS.includes('update'),
    ).toBe(true);
  });
});
