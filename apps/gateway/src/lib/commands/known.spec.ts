import type { KnownPlayer } from '@cod2admin/admin-store';
import { describe, expect, it, vi } from 'vitest';
import { createFakeCtx } from '../testing/fake-ctx.js';
import { createFakeDeps } from '../testing/fake-deps.js';
import { ADMIN_ACCESS } from '../testing/fake-admin-store.js';
import { asRconClient, createFakeRcon } from '../testing/fake-rcon.js';
import { KNOWN_PLAYERS_SETTING_KEY } from '../known-players.js';
import { knownCommand } from './known.js';

const ADMIN = { telegramId: 7, ...ADMIN_ACCESS };

function ctx(match: string) {
  return createFakeCtx({ match, admin: ADMIN });
}

function reply(c: ReturnType<typeof ctx>): string {
  return vi.mocked(c.reply).mock.calls[0]![0] as string;
}

/** A store that remembers saved entries, so `reload` sees them. */
function setup() {
  const fake = createFakeDeps();
  const saved = new Map<string, KnownPlayer>();
  fake.adminStore.saveKnownPlayer.mockImplementation(async (input) => {
    const row = { note: null, ...input, createdAt: new Date(), updatedAt: new Date() } as KnownPlayer;
    saved.set(input.name, row);
    return row;
  });
  fake.adminStore.deleteKnownPlayer.mockImplementation(async (name) => saved.delete(name));
  fake.adminStore.listKnownPlayers.mockImplementation(async () => [...saved.values()]);
  return fake;
}

describe('knownCommand', () => {
  it('shows it is off and empty by default', async () => {
    const { deps } = setup();
    const c = ctx('');
    await knownCommand(c, deps);
    expect(reply(c)).toContain('Known players is OFF');
    expect(reply(c)).toContain('The list is empty.');
  });

  it('turns on and off, saving, applying and auditing', async () => {
    const { deps, adminStore } = setup();
    await knownCommand(ctx('on'), deps);
    expect(deps.knownPlayers.enabled).toBe(true);
    expect(adminStore.setSetting).toHaveBeenCalledWith(KNOWN_PLAYERS_SETTING_KEY, { enabled: true });
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'known', actorTelegramId: 7 }),
    );
    await knownCommand(ctx('off'), deps);
    expect(deps.knownPlayers.enabled).toBe(false);
  });

  it('adds a name with given ASNs, merging into an existing entry', async () => {
    const { deps } = setup();
    await knownCommand(ctx('add Big Vasya AS12389 AS8359'), deps);
    expect(deps.knownPlayers.entries[0]).toMatchObject({ name: 'big vasya', asns: [12389, 8359] });

    const c = ctx('add big vasya AS202226');
    await knownCommand(c, deps);
    expect(deps.knownPlayers.entries[0]!.asns).toEqual([12389, 8359, 202226]);
    expect(deps.knownPlayers.entries[0]!.display).toBe('Big Vasya');
    expect(reply(c)).toContain('/known is off');
  });

  it('takes the ASN of the player online when none is given', async () => {
    const { deps } = setup();
    const rcon = createFakeRcon();
    rcon.status.mockResolvedValue({
      raw: '',
      players: [{ num: 3, score: 0, ping: 1, name: '^1Vasya', ip: '1.1.1.1', guid: '0' }],
    });
    deps.rconClients.set('main', asRconClient(rcon));
    deps.provider = { lookup: () => undefined, asn: () => 12389 };

    await knownCommand(ctx('add vasya'), deps);
    expect(deps.knownPlayers.entries[0]).toMatchObject({ name: 'vasya', asns: [12389] });

    const c = ctx('add nobody');
    await knownCommand(c, deps);
    expect(reply(c)).toContain("isn't online");
  });

  it('adds and removes a network, but keeps at least one', async () => {
    const { deps } = setup();
    await knownCommand(ctx('add Vasya AS1'), deps);
    await knownCommand(ctx('addasn AS2 Vasya'), deps);
    expect(deps.knownPlayers.entries[0]!.asns).toEqual([1, 2]);

    await knownCommand(ctx('removeasn 1 Vasya'), deps);
    expect(deps.knownPlayers.entries[0]!.asns).toEqual([2]);

    const c = ctx('removeasn 2 Vasya');
    await knownCommand(c, deps);
    expect(reply(c)).toContain('last network');
    expect(deps.knownPlayers.entries[0]!.asns).toEqual([2]);
  });

  it('sets a note after a name with spaces, and removes an entry', async () => {
    const { deps } = setup();
    await knownCommand(ctx('add Big Vasya AS1'), deps);
    await knownCommand(ctx('note Big Vasya home + mobile'), deps);
    expect(deps.knownPlayers.entries[0]!.note).toBe('home + mobile');

    await knownCommand(ctx('remove big vasya'), deps);
    expect(deps.knownPlayers.entries).toHaveLength(0);
    const c = ctx('remove big vasya');
    await knownCommand(c, deps);
    expect(reply(c)).toContain("isn't in the list");
  });
});
