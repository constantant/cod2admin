import type { KnownPlayer } from '@cod2admin/admin-store';
import type { StatusPlayer } from '@cod2admin/rcon-client';
import { describe, expect, it } from 'vitest';
import { ChatTemplates, DEFAULT_CHAT_TEMPLATES } from './chat-templates.js';
import { createFakeAdminStore } from './testing/fake-admin-store.js';
import { asRconClient, createFakeRcon } from './testing/fake-rcon.js';
import {
  KnownPlayers,
  normalizeKnownName,
  parseKnownEnabled,
} from './known-players.js';

const ASN_BY_IP: Record<string, number> = {
  '1.1.1.1': 12389,
  '2.2.2.2': 8359,
  '3.3.3.3': 202226,
};
const asnOf = (ip: string) => ASN_BY_IP[ip];

function entry(
  name: string,
  asns: number[],
  guids: string[] = [],
): KnownPlayer {
  const at = new Date();
  return {
    name,
    display: name,
    asns,
    guids,
    note: null,
    createdBy: 1,
    createdAt: at,
    updatedAt: at,
  };
}

function player(
  num: number,
  name: string,
  ip?: string,
  guid = '0',
): StatusPlayer {
  return { num, score: 0, ping: 50, name, ...(ip ? { ip } : {}), guid };
}

function setup(players: StatusPlayer[], enabled = true) {
  const rcon = createFakeRcon();
  rcon.status.mockResolvedValue({ raw: '', players });
  const adminStore = createFakeAdminStore();
  let now = 1_000_000;
  const known = new KnownPlayers(asnOf, () => now);
  known.setEnabled(enabled);
  known.setEntries([entry('vasya', [12389, 8359])]);
  const deps = {
    rconClients: new Map([['main', asRconClient(rcon)]]),
    adminStore,
    chatTemplates: new ChatTemplates(),
  };
  return {
    rcon,
    adminStore,
    known,
    deps,
    advance: (ms: number) => (now += ms),
  };
}

describe('normalizeKnownName', () => {
  it('strips colour codes and case', () => {
    expect(normalizeKnownName('^1Va^7SYA')).toBe('vasya');
  });
});

describe('parseKnownEnabled', () => {
  it('is on only for { enabled: true }', () => {
    expect(parseKnownEnabled({ enabled: true })).toBe(true);
    expect(parseKnownEnabled({ enabled: 'yes' })).toBe(false);
    expect(parseKnownEnabled(undefined)).toBe(false);
  });
});

describe('KnownPlayers.verdict', () => {
  const { known } = setup([]);

  it.each([
    ['unlisted name', player(0, 'Stranger', '3.3.3.3'), 'unknown'],
    ['listed name, listed ASN', player(1, '^1Vasya', '2.2.2.2'), 'known'],
    ['listed name, other ASN', player(2, 'vasya', '3.3.3.3'), 'impostor'],
    [
      'listed name, unresolvable IP',
      player(3, 'Vasya', '9.9.9.9'),
      'unverified',
    ],
    ['listed name, no IP (bot)', player(4, 'Vasya'), 'unverified'],
  ])('%s → %s', (_label, subject, expected) => {
    expect(known.verdict(subject)).toBe(expected);
  });
});

describe('KnownPlayers.verdict with GUIDs', () => {
  const known = new KnownPlayers(asnOf);
  known.setEntries([
    entry('vasya', [12389], ['716922']),
    entry('petya', [8359]),
    entry('guidonly', [], ['555']),
  ]);

  it.each([
    [
      'stored GUID vouches from any network',
      player(0, 'Vasya', '3.3.3.3', '716922'),
      'known',
    ],
    [
      'GUID 0 falls back to the ASN: fits',
      player(1, 'Vasya', '1.1.1.1'),
      'known',
    ],
    ['GUID 0, other ASN', player(2, 'Vasya', '3.3.3.3'), 'impostor'],
    [
      'another real GUID from a listed ASN is a suspect',
      player(3, 'Vasya', '1.1.1.1', '999'),
      'suspect',
    ],
    [
      'another real GUID from another ASN is kicked',
      player(4, 'Vasya', '3.3.3.3', '999'),
      'impostor',
    ],
    [
      'another real GUID, ASN unknown: a suspect',
      player(5, 'Vasya', '9.9.9.9', '999'),
      'suspect',
    ],
    [
      'a real GUID where none is stored: ASN decides',
      player(6, 'Petya', '2.2.2.2', '999'),
      'known',
    ],
    [
      'GUID-only entry, GUID 0: nothing to check',
      player(7, 'GuidOnly', '3.3.3.3'),
      'unverified',
    ],
    [
      'GUID-only entry, wrong GUID: flagged',
      player(8, 'GuidOnly', '3.3.3.3', '1'),
      'suspect',
    ],
  ])('%s → %s', (_label, subject, expected) => {
    expect(known.verdict(subject)).toBe(expected);
  });

  it('kicks a suspect (other GUID), says why, and does not protect one from a VPN kick', async () => {
    const {
      rcon,
      adminStore,
      deps,
      known: live,
    } = setup([
      player(3, 'Vasya', '2.2.2.2', '999'),
      player(4, 'Vasya', '2.2.2.2', '716922'),
    ]);
    live.setEntries([entry('vasya', [8359], ['716922'])]);
    await live.sweep(deps);
    expect(rcon.kick).toHaveBeenCalledTimes(1);
    expect(rcon.kick).toHaveBeenCalledWith(3, 'Vasya');
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'known_kick',
        detailJson: { ip: '2.2.2.2', guid: '999', reason: 'guid', asn: 8359 },
      }),
    );
    expect(live.isProtected(player(3, 'Vasya', '2.2.2.2', '999'))).toBe(false);
    expect(live.isProtected(player(3, 'Vasya', '2.2.2.2', '716922'))).toBe(
      true,
    );
  });

  it('says what marking a player as known would add', () => {
    expect(known.additions(player(0, 'Vasya', '3.3.3.3', '716922'))).toEqual({
      asn: 202226,
    });
    expect(known.additions(player(0, 'Vasya', '1.1.1.1', '716922'))).toEqual(
      {},
    );
    expect(known.additions(player(0, 'Petya', '2.2.2.2', '4'))).toEqual({
      guid: '4',
    });
    expect(known.additions(player(0, 'New', '1.1.1.1', '7'))).toEqual({
      asn: 12389,
      guid: '7',
    });
    expect(known.additions(player(0, 'New', '9.9.9.9'))).toEqual({});
  });
});

describe('KnownPlayers.sweep', () => {
  const PLAYERS = [
    player(0, 'Vasya', '2.2.2.2'),
    player(1, 'VASYA', '3.3.3.3'),
    player(2, 'Stranger', '3.3.3.3'),
    player(3, 'Vasya', '9.9.9.9'),
  ];

  it('does nothing — not even a status query — while off', async () => {
    const { rcon, known, deps } = setup(PLAYERS, false);
    await known.sweep(deps);
    expect(rcon.status).not.toHaveBeenCalled();
  });

  it('kicks only the listed name from an unlisted network, and audits it', async () => {
    const { rcon, adminStore, known, deps } = setup(PLAYERS);
    await known.sweep(deps);

    expect(rcon.kick).toHaveBeenCalledTimes(1);
    expect(rcon.kick).toHaveBeenCalledWith(1, 'VASYA');
    expect(rcon.say).not.toHaveBeenCalled();
    expect(adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'known_kick',
        target: 'VASYA',
        serverAlias: 'main',
        source: 'auto',
        detailJson: {
          ip: '3.3.3.3',
          guid: null,
          reason: 'network',
          asn: 202226,
        },
      }),
    );
  });

  it('kicks every sweep but audits and announces once per window', async () => {
    const { rcon, adminStore, known, deps, advance } = setup(PLAYERS);
    deps.chatTemplates.setAll({
      ...DEFAULT_CHAT_TEMPLATES,
      known_kick: '{name} is not who they claim',
    });

    await known.sweep(deps);
    await known.sweep(deps);
    expect(rcon.kick).toHaveBeenCalledTimes(2);
    expect(rcon.say).toHaveBeenCalledTimes(1);
    expect(adminStore.recordAuditLog).toHaveBeenCalledTimes(1);

    advance(5 * 60 * 1000);
    await known.sweep(deps);
    expect(adminStore.recordAuditLog).toHaveBeenCalledTimes(2);
  });

  it('skips a server that fails and carries on', async () => {
    const { known, deps } = setup(PLAYERS);
    const broken = createFakeRcon();
    broken.status.mockRejectedValue(new Error('timeout'));
    deps.rconClients = new Map([
      ['broken', asRconClient(broken)],
      ...deps.rconClients,
    ]);

    await expect(known.sweep(deps)).resolves.toBeUndefined();
  });
});

describe('KnownPlayers.isProtected', () => {
  it('protects known and unverified players, only while on', () => {
    const { known } = setup([]);
    expect(known.isProtected(player(0, 'Vasya', '2.2.2.2'))).toBe(true);
    expect(known.isProtected(player(0, 'Vasya', '9.9.9.9'))).toBe(true);
    expect(known.isProtected(player(0, 'Vasya', '3.3.3.3'))).toBe(false);
    expect(known.isProtected(player(0, 'Stranger', '2.2.2.2'))).toBe(false);
    known.setEnabled(false);
    expect(known.isProtected(player(0, 'Vasya', '2.2.2.2'))).toBe(false);
  });
});
