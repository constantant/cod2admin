import type { Mute } from '@cod2admin/ban-store';
import type { ChatEvent } from '@cod2admin/log-tailer';
import { beforeEach, describe, expect, it } from 'vitest';
import { findMute, MUTE_WARNING, MuteEnforcer } from './mute-enforcer.js';
import { createFakeAdminStore } from './testing/fake-admin-store.js';
import { createFakeBanStore } from './testing/fake-ban-store.js';
import { asRconClient, createFakeRcon } from './testing/fake-rcon.js';

function mute(overrides: Partial<Mute> = {}): Mute {
  return {
    id: 1,
    serverAlias: 'default',
    name: 'Spammer',
    guid: null,
    ip: '1.2.3.4',
    reason: null,
    mutedBy: 1,
    mutedAt: new Date(),
    expiresAt: null,
    unmutedAt: null,
    ...overrides,
  };
}

function chat(message: string, num = 3): ChatEvent {
  return {
    channel: 'say',
    guid: '0',
    num,
    name: 'NewName',
    message,
    timestamp: { minutes: 1, seconds: 2 },
    raw: '',
  };
}

describe('findMute', () => {
  it('matches a renamed player by IP', () => {
    expect(findMute([mute()], { name: 'NewName', ip: '1.2.3.4' })?.id).toBe(1);
  });

  it('matches by a real GUID', () => {
    const byGuid = mute({ guid: 'abc', ip: null });
    expect(findMute([byGuid], { name: 'X', guid: 'abc' })?.id).toBe(1);
  });

  it('never matches on GUID 0', () => {
    const byGuid = mute({ guid: '0', ip: null });
    expect(findMute([byGuid], { name: 'X', guid: '0' })).toBeUndefined();
  });

  it("doesn't match missing fields to each other", () => {
    const noIp = mute({ guid: 'abc', ip: null });
    expect(findMute([noIp], { name: 'Spammer' })).toBeUndefined();
  });

  it('uses the name only for a mute with no GUID or IP', () => {
    const nameOnly = mute({ ip: null });
    expect(findMute([nameOnly], { name: 'Spammer' })?.id).toBe(1);
    expect(findMute([nameOnly], { name: 'Other' })).toBeUndefined();
  });
});

describe('MuteEnforcer', () => {
  let rcon: ReturnType<typeof createFakeRcon>;
  let banStore: ReturnType<typeof createFakeBanStore>;
  let adminStore: ReturnType<typeof createFakeAdminStore>;
  let enforcer: MuteEnforcer;

  beforeEach(() => {
    rcon = createFakeRcon();
    rcon.status.mockResolvedValue({
      raw: '',
      players: [
        { num: 3, name: 'NewName', score: 0, ping: 0, ip: '1.2.3.4' },
        { num: 4, name: 'Innocent', score: 0, ping: 0, ip: '5.6.7.8' },
      ],
    });
    banStore = createFakeBanStore();
    banStore.listActiveMutes.mockResolvedValue([mute()]);
    adminStore = createFakeAdminStore();
    enforcer = new MuteEnforcer({
      serverAlias: 'default',
      rcon: () => asRconClient(rcon),
      banStore,
      adminStore,
    });
  });

  it('warns on the first message, then kicks on every later one', async () => {
    await enforcer.handle(chat('one'));
    expect(rcon.tell).toHaveBeenCalledWith(3, MUTE_WARNING);
    expect(rcon.kick).not.toHaveBeenCalled();

    await enforcer.handle(chat('two'));
    await enforcer.handle(chat('three'));
    expect(rcon.tell).toHaveBeenCalledTimes(1);
    expect(rcon.kick).toHaveBeenCalledTimes(2);
    expect(rcon.kick).toHaveBeenCalledWith('NewName');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mute_kick',
        target: 'NewName',
        source: 'auto',
        actorTelegramId: 0,
      }),
    );
  });

  it('leaves other players alone', async () => {
    await enforcer.handle(chat('hello', 4));
    await enforcer.handle(chat('hello', 4));

    expect(rcon.tell).not.toHaveBeenCalled();
    expect(rcon.kick).not.toHaveBeenCalled();
  });

  it("doesn't count a !report or an empty message", async () => {
    await enforcer.handle(chat('!report Griefer aimbot'));
    await enforcer.handle(chat('\x15  '));

    expect(rcon.tell).not.toHaveBeenCalled();
    expect(rcon.status).not.toHaveBeenCalled();
  });

  it("doesn't ask the server anything while nobody is muted", async () => {
    banStore.listActiveMutes.mockResolvedValue([]);

    await enforcer.handle(chat('hello'));

    expect(rcon.status).not.toHaveBeenCalled();
  });

  it('does nothing once the slot is empty', async () => {
    await enforcer.handle(chat('hello', 9));

    expect(rcon.tell).not.toHaveBeenCalled();
    expect(rcon.kick).not.toHaveBeenCalled();
  });
});
