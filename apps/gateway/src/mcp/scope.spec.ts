import { describe, expect, it } from 'vitest';
import {
  MCP_PERMISSIONS,
  connectionPermissions,
  grantablePermissions,
  parseScope,
  seesChat,
} from './scope.js';

describe('parseScope', () => {
  it('treats an omitted scope as read-only', () => {
    expect(parseScope(undefined)).toEqual({ permissions: [], scope: 'read' });
    expect(parseScope('')).toEqual({ permissions: [], scope: 'read' });
    expect(parseScope('   ')).toEqual({ permissions: [], scope: 'read' });
  });

  it('keeps each named action once, with read first', () => {
    expect(parseScope('kick read kick ban')).toEqual({
      permissions: ['kick', 'ban'],
      scope: 'read kick ban',
    });
  });

  it('rejects permissions that stay in Telegram, and unknown ids', () => {
    for (const token of ['update', 'relays', 'admins.manage', 'servers.manage', 'mute', 'nope']) {
      expect(parseScope(token)).toBe(`Unknown scope: ${token}`);
    }
  });
});

describe('grantablePermissions', () => {
  it('returns the overlap of what was asked and what the person holds', () => {
    expect(
      grantablePermissions(
        { isOwner: false, permissions: ['kick', 'say'] },
        ['kick', 'ban', 'rcon'],
      ),
    ).toEqual(['kick']);
  });

  it('lets the owner grant rcon when it was asked, and nothing they were not asked', () => {
    expect(
      grantablePermissions({ isOwner: true, permissions: [] }, ['kick', 'rcon']),
    ).toEqual(['kick', 'rcon']);
    expect(grantablePermissions({ isOwner: true, permissions: [] }, ['kick'])).toEqual([
      'kick',
    ]);
  });
});

describe('connectionPermissions', () => {
  it('keeps the snapshot, dropping a permission the person has since lost', () => {
    expect(
      connectionPermissions(
        { isOwner: false, permissions: ['kick'] },
        ['kick', 'ban', 'update'],
      ),
    ).toEqual(['kick']);
  });

  it('does not grow an owner snapshot when they hold more than they approved', () => {
    expect(
      connectionPermissions({ isOwner: true, permissions: [] }, ['kick']),
    ).toEqual(['kick']);
    expect(MCP_PERMISSIONS).not.toContain('update');
    expect(MCP_PERMISSIONS).not.toContain('admins.manage');
  });
});

describe('seesChat', () => {
  it('allows chat for read-only and say, and hides it once the connection can act', () => {
    expect(seesChat([])).toBe(true);
    expect(seesChat(['say', 'servers.view', 'cvars.read', 'audit'])).toBe(true);
    expect(seesChat(['kick'])).toBe(false);
    expect(seesChat(['say', 'ban'])).toBe(false);
    expect(seesChat(['rcon'])).toBe(false);
    expect(seesChat(['maps'])).toBe(false);
    expect(seesChat(['cvars.write'])).toBe(false);
    expect(seesChat(['servers.assign'])).toBe(false);
  });
});
