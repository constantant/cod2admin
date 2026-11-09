import type { KnownPlayer } from '@cod2admin/admin-store';
import type { StatusPlayer } from '@cod2admin/rcon-client';
import { describe, expect, it } from 'vitest';
import { ChatTemplates, DEFAULT_CHAT_TEMPLATES } from './chat-templates.js';
import { createFakeAdminStore } from './testing/fake-admin-store.js';
import { asRconClient, createFakeRcon } from './testing/fake-rcon.js';
import { KnownPlayers, normalizeKnownName, parseKnownEnabled } from './known-players.js';

const ASN_BY_IP: Record<string, number> = { '1.1.1.1': 12389, '2.2.2.2': 8359, '3.3.3.3': 202226 };
const asnOf = (ip: string) => ASN_BY_IP[ip];

function entry(name: string, asns: number[]): KnownPlayer {
  const at = new Date();
  return { name, display: name, asns, note: null, createdBy: 1, createdAt: at, updatedAt: at };
}

function player(num: number, name: string, ip?: string): StatusPlayer {
  return { num, score: 0, ping: 50, name, ...(ip ? { ip } : {}), guid: '0' };
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
  return { rcon, adminStore, known, deps, advance: (ms: number) => (now += ms) };
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
    ['listed name, unresolvable IP', player(3, 'Vasya', '9.9.9.9'), 'unverified'],
    ['listed name, no IP (bot)', player(4, 'Vasya'), 'unverified'],
  ])('%s → %s', (_label, subject, expected) => {
    expect(known.verdict(subject)).toBe(expected);
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
        detailJson: { ip: '3.3.3.3', asn: 202226 },
      }),
    );
  });

  it('kicks every sweep but audits and announces once per window', async () => {
    const { rcon, adminStore, known, deps, advance } = setup(PLAYERS);
    deps.chatTemplates.setAll({ ...DEFAULT_CHAT_TEMPLATES, known_kick: '{name} is not who they claim' });

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
    deps.rconClients = new Map([['broken', asRconClient(broken)], ...deps.rconClients]);

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
