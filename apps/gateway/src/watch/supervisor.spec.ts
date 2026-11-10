import { PassThrough } from 'node:stream';
import {
  DEFAULT_SERVER_WATCH_SETTINGS,
  type ServerConfig,
  type ServerWatchSettings,
} from '@cod2admin/admin-store';
import {
  samplesFromSnapshot,
  type EntityObservation,
} from '@cod2admin/game-client';
import type { Sample } from '@cod2admin/player-watch';
import { ReportAntiSpam } from '@cod2admin/report-pipeline';
import type { StatusPlayer } from '@cod2admin/rcon-client';
import type {
  PopulationMoments,
  RecordEvidenceInput,
  RecordLifeInput,
  WatchIdentityKind,
  WatchProfile,
  WatchStore,
} from '@cod2admin/watch-store';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ReportQueue } from '../lib/report-queue.js';
import {
  createFakeAdminStore,
  type FakeAdminStore,
} from '../lib/testing/fake-admin-store.js';
import {
  createFakeBanStore,
  type FakeBanStore,
} from '../lib/testing/fake-ban-store.js';
import { createFakeRcon, type FakeRcon } from '../lib/testing/fake-rcon.js';
import { createWatchChild } from './child.js';
import {
  startWatchSupervisor,
  type SpawnedWatch,
  type WatchSpawn,
  type WatchSupervisor,
} from './supervisor.js';

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const SECRET = 's3cret-private';
const OTHER_SECRET = 'other-private-secret';
const RCON_SECRET = 'rcon-pass-not-hello';

const OPEN = {
  cvars: { protocol: '118', sv_pure: '0', sv_punkbuster: '0' },
  players: [],
};

const PLAYER: StatusPlayer = {
  num: 4,
  score: 10,
  ping: 20,
  name: '^1Cheater',
  guid: 'abc',
  ip: '203.0.113.8',
};

interface FakeChild extends Omit<SpawnedWatch, 'stdout'> {
  stdout: PassThrough;
  text(): string;
  killed: boolean;
}

interface Memory {
  store: WatchStore;
  lives: RecordLifeInput[];
  evidence: RecordEvidenceInput[];
  profiles: Map<string, WatchProfile>;
  moments: Map<string, PopulationMoments>;
  populationReads: () => number;
  /** `distinctNames24h`. Default 1. */
  nameCount: { value: number };
}

interface Draft {
  adminStore: FakeAdminStore;
  banStore: FakeBanStore;
  rcon: FakeRcon;
  rcons: Map<string, FakeRcon>;
  servers: ServerConfig[];
  memory: Memory;
  children: FakeChild[];
  spawn: Mock<WatchSpawn>;
  cards: string[];
  warnings: string[];
  antiSpam: ReportAntiSpam<string>;
  exit: ReturnType<typeof vi.spyOn>;
  nowMs: number;
}

const stopped: WatchSupervisor[] = [];
const drafts: Draft[] = [];

afterEach(() => {
  for (const supervisor of stopped.splice(0)) {
    supervisor.stop();
  }
  for (const draft of drafts.splice(0)) {
    expect(draft.exit).not.toHaveBeenCalled();
    draft.exit.mockRestore();
  }
});

describe('watch supervisor', () => {
  it('spawns no child when every watch is null', async () => {
    const draft = draftHarness();
    draft.servers.push(
      server({ watch: null }),
      server({ alias: 'two', watch: null }),
    );
    const supervisor = await boot(draft);
    expect(supervisor.running).toBe(true);
    expect(draft.spawn).not.toHaveBeenCalled();
    expect(draft.rcon.getStatus).not.toHaveBeenCalled();
  });

  it('spawns with pipes and detached false, and the spawn args carry no secret', async () => {
    const draft = draftHarness();
    draft.servers.push(
      enabled({ join: 'private' }, { watchPrivatePassword: SECRET }),
    );
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    await boot(draft);
    expect(draft.spawn).toHaveBeenCalledOnce();
    const call = draft.spawn.mock.calls[0];
    expect(call?.[1]).toEqual([expect.stringMatching(/child\.js$/)]);
    expect(call?.[2]).toEqual({
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
    expect(JSON.stringify(call)).not.toContain(SECRET);
    expect(JSON.stringify(call)).not.toContain(RCON_SECRET);
  });

  it('names each enabled server on hello, and reload has no secret', async () => {
    const draft = draftHarness();
    const row = enabled(
      { join: 'private', spectatorName: 'AdminWatch' },
      {
        watchPrivatePassword: SECRET,
      },
    );
    draft.servers.push(row);
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    const supervisor = await boot(draft);
    const hello = messages(draft.children[0]!);
    expect(hello).toHaveLength(1);
    expect(hello[0]).toMatchObject({
      type: 'hello',
      servers: [{ alias: 'default', password: SECRET }],
    });

    row.watch = { ...row.watch!, spectatorName: 'Spotter' };
    await supervisor.sync();
    const lines = messages(draft.children[0]!);
    expect(draft.spawn).toHaveBeenCalledOnce();
    expect(lines[1]).toMatchObject({
      type: 'reload',
      servers: [{ alias: 'default', spectatorName: 'Spotter' }],
    });
    expect(JSON.stringify(lines[1])).not.toContain(SECRET);
    expect(lines[1]).not.toHaveProperty('servers.0.password');
  });

  it('restarts the child when private join is turned on', async () => {
    const draft = draftHarness();
    const row = enabled(
      { join: 'spectator' },
      { watchPrivatePassword: SECRET },
    );
    draft.servers.push(row);
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    const supervisor = await boot(draft);
    expect(JSON.stringify(messages(draft.children[0]!))).not.toContain(SECRET);

    row.watch = { ...row.watch!, join: 'private' };
    await supervisor.sync();
    expect(draft.spawn).toHaveBeenCalledTimes(2);
    expect(draft.children[0]?.killed).toBe(true);
    const again = messages(draft.children[1]!);
    expect(again[0]).toMatchObject({
      type: 'hello',
      servers: [{ alias: 'default', password: SECRET }],
    });
    expect(JSON.stringify(messages(draft.children[0]!))).not.toContain(SECRET);
    const reloads = again.filter((line) => line['type'] === 'reload');
    expect(JSON.stringify(reloads)).not.toContain(SECRET);
  });

  it('puts two private servers on one hello', async () => {
    const draft = draftHarness();
    const second = createFakeRcon();
    second.getStatus.mockResolvedValue(OPEN);
    draft.rcons.set('two', second);
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    draft.servers.push(
      enabled(
        { join: 'private' },
        { alias: 'default', watchPrivatePassword: SECRET },
      ),
      enabled(
        { join: 'private' },
        {
          alias: 'two',
          rconHost: '10.0.0.8',
          rconPort: 28961,
          watchPrivatePassword: OTHER_SECRET,
        },
      ),
    );
    await boot(draft);
    expect(draft.spawn).toHaveBeenCalledOnce();
    const hello = messages(draft.children[0]!)[0] as {
      type: string;
      servers: { alias: string; password?: string }[];
    };
    expect(hello.type).toBe('hello');
    expect(hello.servers.map((server) => server.alias).sort()).toEqual([
      'default',
      'two',
    ]);
    expect(
      hello.servers.find((server) => server.alias === 'default')?.password,
    ).toBe(SECRET);
    expect(
      hello.servers.find((server) => server.alias === 'two')?.password,
    ).toBe(OTHER_SECRET);
  });

  it('does not call rcon.kick when a kick-shaped life is in flag mode', async () => {
    const { draft, supervisor } = await armed('flag');
    await feed(supervisor, draft, kickLife({ endedAtMs: NOW - 1000 }));
    expect(draft.rcon.kick).not.toHaveBeenCalled();
    expect(draft.memory.evidence.map((row) => row.action)).toEqual(['flag']);
    expect(draft.cards.some((text) => text.includes('flagged Cheater'))).toBe(
      true,
    );
    expect(draft.adminStore.recordReport).not.toHaveBeenCalled();
  });

  it('sends one clientkick when one fresh guid row matches', async () => {
    let status: FakeRcon['status'] | undefined;
    const { draft, supervisor } = await armed('kick', {
      prepare(ready) {
        status = ready.rcon.status;
      },
    });
    await feed(
      supervisor,
      draft,
      kickLife({ selfLives: 8, endedAtMs: NOW - 1000 }),
    );
    expect(status).not.toHaveBeenCalled();
    expect(draft.rcon.kick).toHaveBeenCalledTimes(1);
    expect(draft.rcon.kick).toHaveBeenCalledWith(PLAYER.num, undefined, {
      slotOnly: true,
    });
    expect(draft.rcon.say).toHaveBeenCalledWith('Cheater was kicked');
    expect(draft.rcon.say).not.toHaveBeenCalledWith(
      expect.stringContaining('admin'),
    );
    expect(draft.rcon.banClient).not.toHaveBeenCalled();
    expect(draft.banStore.recordBan).not.toHaveBeenCalled();
    expect(draft.banStore.recordIpBan).not.toHaveBeenCalled();
    expect(draft.memory.evidence.map((row) => row.action)).toEqual(['kick']);
    expect(draft.memory.lives[0]?.mapName).toBe('mp_toujane');
    expect(draft.adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorTelegramId: 0,
        action: 'watch_kick',
        source: 'auto',
        detailJson: expect.objectContaining({
          watch: true,
          evidenceId: 'ev-1',
        }),
      }),
    );
    const detail = JSON.stringify(draft.adminStore.recordAuditLog.mock.calls);
    expect(detail).not.toContain(PLAYER.ip);
    expect(draft.adminStore.recordReport).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'watch', targetName: 'Cheater' }),
    );
    expect(draft.cards.some((text) => text.includes('Already kicked.'))).toBe(
      true,
    );
  });

  it('does not rewrite the stored map from a later kick status', async () => {
    const { draft, supervisor } = await armed('kick', {
      prepare(ready) {
        ready.rcon.status.mockImplementation(async () => {
          ready.nowMs = NOW + 1000;
          return {
            raw: '',
            mapName: 'mp_carentan',
            players: [{ ...PLAYER, num: 9 }],
          };
        });
      },
    });
    await feed(supervisor, draft, kickLife({ endedAtMs: NOW }));
    expect(draft.memory.lives[0]?.mapName).toBe('mp_toujane');
    expect(draft.rcon.kick).toHaveBeenCalledTimes(1);
    expect(draft.rcon.kick).toHaveBeenCalledWith(9, undefined, {
      slotOnly: true,
    });
  });

  it('does not kick an hwid profile when the guid is 0', async () => {
    const watched: StatusPlayer = { ...PLAYER, guid: '0' };
    const innocent: StatusPlayer = {
      ...PLAYER,
      num: 5,
      guid: 'abc',
      name: 'Innocent',
      ip: '198.51.100.9',
    };
    const { draft, supervisor } = await armed('kick', {
      players: [watched, innocent],
      profileKey: 'hwid:99',
      kind: 'hwid',
      lastGuid: 'abc',
    });
    draft.rcon.dumpuser = vi.fn(async () => ({ cl_hwid: '99' }));
    await feed(
      supervisor,
      draft,
      kickLife({ selfLives: 8, endedAtMs: NOW - 1000 }),
    );
    expect(draft.rcon.kick).not.toHaveBeenCalled();
    expect(
      draft.memory.evidence.map((row) => [row.action, row.reason]),
    ).toEqual([['suppressed', 'guid0']]);
    expect(
      draft.cards.some((text) => text.includes('Kick was not sent.')),
    ).toBe(true);
    expect(draft.banStore.recordBan).not.toHaveBeenCalled();
  });

  it('does not kick when two status rows share an ip', async () => {
    const ip = PLAYER.ip ?? '';
    const { draft, supervisor } = await armed('kick', {
      players: [
        { ...PLAYER, guid: '0', ip },
        { ...PLAYER, num: 5, guid: '0', name: 'Other', ip },
      ],
      profileKey: `ip:${ip}`,
      kind: 'ip',
      lastGuid: null,
      names: 1,
    });
    await feed(
      supervisor,
      draft,
      kickLife({ selfLives: 8, endedAtMs: NOW - 1000 }),
    );
    expect(draft.rcon.kick).not.toHaveBeenCalled();
    expect(
      draft.memory.evidence.map((row) => [row.action, row.reason]),
    ).toEqual([['suppressed', 'ambiguous_slot']]);
    const detail = JSON.stringify(draft.adminStore.recordAuditLog.mock.calls);
    expect(detail).not.toContain(ip);
    expect(
      draft.cards.some((text) => text.includes('Kick was not sent.')),
    ).toBe(true);
    const caps = await draft.memory.store.loadCaps({
      serverAlias: 'default',
      profileKey: `ip:${ip}`,
      now: new Date(NOW),
      cooldownMs: 30 * 60 * 1000,
    });
    expect(caps.cardsThisHour).toBe(0);
    expect(caps.cooldownActive).toBe(false);
  });

  it('does not kick an ip profile when no name was stored', async () => {
    const ip = PLAYER.ip ?? '';
    const { draft, supervisor } = await armed('kick', {
      players: [{ ...PLAYER, guid: '0', ip }],
      profileKey: `ip:${ip}`,
      kind: 'ip',
      lastGuid: null,
      names: 0,
    });
    await feed(
      supervisor,
      draft,
      kickLife({ selfLives: 8, endedAtMs: NOW - 1000 }),
    );
    expect(draft.rcon.kick).not.toHaveBeenCalled();
    expect(draft.memory.evidence.map((row) => row.action)).toEqual(['report']);
  });

  it('does not say or send kick <slot> when clientkick is unknown', async () => {
    const { draft, supervisor } = await armed('kick');
    draft.rcon.kick.mockResolvedValue('Unknown command "clientkick"');
    await feed(
      supervisor,
      draft,
      kickLife({ selfLives: 8, endedAtMs: NOW - 1000 }),
    );
    expect(draft.rcon.kick).toHaveBeenCalledTimes(1);
    expect(draft.rcon.kick).toHaveBeenCalledWith(PLAYER.num, undefined, {
      slotOnly: true,
    });
    expect(draft.rcon.say).not.toHaveBeenCalled();
    expect(draft.rcon.banClient).not.toHaveBeenCalled();
    expect(
      draft.memory.evidence.map((row) => [row.action, row.reason]),
    ).toEqual([['suppressed', 'no_clientkick']]);
    expect(draft.adminStore.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'watch_kick_suppressed' }),
    );
    expect(draft.adminStore.recordAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'watch_kick' }),
    );
    expect(
      draft.cards.some((text) => text.includes('Kick was not sent.')),
    ).toBe(true);
  });

  it.each(['map', 'disconnect'] as const)(
    'does not kick a life that ended by %s',
    async (endReason) => {
      const { draft, supervisor } = await armed('kick');
      await feed(
        supervisor,
        draft,
        kickLife({ endReason, endedAtMs: NOW - 1000 }),
      );
      expect(draft.rcon.kick).not.toHaveBeenCalled();
    },
  );

  it('ignores an IPC selfLives claim when the stored count is 0', async () => {
    const { draft, supervisor } = await armed('kick');
    draft.memory.profiles.clear();
    await feed(
      supervisor,
      draft,
      kickLife({ selfLives: 8, endedAtMs: NOW - 1000 }),
    );
    expect(draft.rcon.kick).not.toHaveBeenCalled();
    expect(draft.memory.evidence.some((row) => row.action === 'kick')).toBe(
      false,
    );
  });

  it('does not setCvar when a disabled server already has a private password', async () => {
    const draft = draftHarness();
    draft.servers.push(
      enabled(
        { enabled: false, join: 'private' },
        { watchPrivatePassword: 'already-set' },
      ),
    );
    await boot(draft);
    expect(draft.rcon.setCvar).not.toHaveBeenCalled();
    expect(draft.rcon.getStatus).not.toHaveBeenCalled();
    expect(draft.spawn).not.toHaveBeenCalled();
  });

  it('does not spawn when sv_pure or sv_punkbuster is missing or not 0', async () => {
    const pure = draftHarness();
    pure.servers.push(enabled());
    pure.rcon.getStatus.mockResolvedValue({
      cvars: { protocol: '118', sv_pure: '1', sv_punkbuster: '0' },
      players: [],
    });
    const pureSupervisor = await boot(pure);
    expect(pure.spawn).not.toHaveBeenCalled();
    expect(
      pure.warnings.some(
        (line) => line.includes('not joining') && line.includes('sv_pure'),
      ),
    ).toBe(true);
    await pureSupervisor.sync();
    expect(pure.rcon.getStatus).toHaveBeenCalledTimes(2);
    expect(pure.spawn).not.toHaveBeenCalled();

    const pb = draftHarness();
    pb.servers.push(enabled());
    pb.rcon.getStatus.mockResolvedValue({
      cvars: { protocol: '118', sv_pure: '0' },
      players: [],
    });
    await boot(pb);
    expect(pb.spawn).not.toHaveBeenCalled();
    expect(pb.warnings.some((line) => line.includes('sv_punkbuster'))).toBe(
      true,
    );
  });

  it('sends a map line only when a real map name changes', async () => {
    const draft = draftHarness();
    draft.servers.push(
      enabled({ join: 'private' }, { watchPrivatePassword: SECRET }),
    );
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    const supervisor = await boot(draft);
    supervisor.noteStatus(
      'default',
      { raw: '', mapName: 'mp_toujane', players: [] },
      NOW,
    );
    await supervisor.whenIdle();
    const seeded = messages(draft.children[0]!).filter(
      (line) => line['type'] !== 'hello',
    );
    expect(seeded.filter((line) => line['type'] === 'map')).toEqual([]);
    expect(seeded).toEqual([
      {
        type: 'reload',
        servers: [
          expect.objectContaining({ alias: 'default', mapName: 'mp_toujane' }),
        ],
      },
    ]);
    expect(JSON.stringify(seeded)).not.toContain(SECRET);
    expect(JSON.stringify(seeded)).not.toContain(RCON_SECRET);

    supervisor.noteStatus(
      'default',
      { raw: '', mapName: 'mp_toujane', players: [] },
      NOW,
    );
    await supervisor.whenIdle();
    expect(
      messages(draft.children[0]!).filter((line) => line['type'] === 'map'),
    ).toEqual([]);
    const confirms = messages(draft.children[0]!).filter(
      (line) => line['type'] === 'confirm',
    );
    expect(confirms).toEqual([
      { type: 'confirm', serverAlias: 'default', mapName: 'mp_toujane' },
    ]);
    expect(JSON.stringify(confirms)).not.toContain(SECRET);
    expect(JSON.stringify(confirms)).not.toContain(RCON_SECRET);

    supervisor.noteStatus(
      'default',
      { raw: '', mapName: 'mp_carentan', players: [] },
      NOW,
    );
    await supervisor.whenIdle();
    const after = messages(draft.children[0]!).filter(
      (line) => line['type'] !== 'hello',
    );
    expect(after.filter((line) => line['type'] === 'map')).toEqual([
      { type: 'map', serverAlias: 'default', mapName: 'mp_carentan' },
    ]);
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(JSON.stringify(after)).not.toContain(RCON_SECRET);
  });

  it('stores a null map and does not score it', async () => {
    const draft = draftHarness();
    draft.servers.push(enabled({ mode: 'flag' }));
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    const supervisor = await boot(draft);
    supervisor.noteStatus('default', { raw: '', players: [PLAYER] }, NOW);
    await supervisor.whenIdle();
    await feed(supervisor, draft, speedLife());
    expect(draft.memory.lives).toHaveLength(1);
    expect(draft.memory.lives[0]).toMatchObject({
      mapName: null,
      lifeScore: null,
      profileKey: 'guid:abc',
    });
    expect(draft.memory.populationReads()).toBe(0);
    expect(draft.memory.evidence).toHaveLength(0);
    expect(draft.cards).toHaveLength(0);
  });

  it('mode off scores and stores an extreme life and emits nothing', async () => {
    const draft = draftHarness();
    draft.servers.push(enabled({ mode: 'off' }));
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    draft.memory.moments.set('speedOverG', { n: 5000, mean: 0, m2: 4999 });
    const supervisor = await boot(draft);
    await seen(supervisor);
    await feed(supervisor, draft, speedLife());
    expect(draft.memory.lives[0]).toMatchObject({
      mapName: 'mp_toujane',
      excludedFromPopulation: true,
    });
    expect(draft.memory.lives[0]?.lifeScore ?? 0).toBeGreaterThanOrEqual(4);
    expect(draft.memory.evidence).toHaveLength(0);
    expect(draft.adminStore.recordReport).not.toHaveBeenCalled();
    expect(draft.cards).toHaveLength(0);
    expect(draft.rcon.kick).not.toHaveBeenCalled();
    expect(draft.antiSpam.check).not.toHaveBeenCalled();
  });

  it('flag sends a card and does not insert a report', async () => {
    const draft = draftHarness();
    draft.servers.push(enabled({ mode: 'flag' }));
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    draft.memory.moments.set('speedOverG', { n: 5000, mean: 0, m2: 4999 });
    const supervisor = await boot(draft);
    await seen(supervisor);
    await feed(supervisor, draft, speedLife());
    expect(draft.adminStore.recordReport).not.toHaveBeenCalled();
    expect(draft.memory.evidence.map((row) => row.action)).toEqual(['flag']);
    expect(draft.cards.some((text) => text.includes('flagged Cheater'))).toBe(
      true,
    );
    expect(draft.antiSpam.check).not.toHaveBeenCalled();
    expect(draft.antiSpam.resolve).not.toHaveBeenCalled();
  });

  it('report uses origin watch and does not use ReportAntiSpam', async () => {
    const draft = draftHarness();
    draft.servers.push(enabled({ mode: 'report' }));
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    draft.memory.moments.set('speedOverG', { n: 5000, mean: 0, m2: 4999 });
    const supervisor = await boot(draft);
    await seen(supervisor);
    await feed(supervisor, draft, speedLife());
    expect(draft.adminStore.recordReport).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'watch', targetName: 'Cheater' }),
    );
    expect(draft.memory.evidence[0]).toMatchObject({
      action: 'report',
      reportId: 1,
    });
    expect(draft.antiSpam.check).not.toHaveBeenCalled();
    expect(draft.antiSpam.resolve).not.toHaveBeenCalled();
    expect(draft.antiSpam.track).not.toHaveBeenCalled();
  });

  it('a suppressed row inside an open cooldown does not extend it', async () => {
    const draft = draftHarness();
    draft.servers.push(enabled({ mode: 'flag' }));
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    draft.memory.moments.set('speedOverG', { n: 5000, mean: 0, m2: 4999 });
    await draft.memory.store.recordEvidence({
      serverAlias: 'default',
      profileKey: 'guid:abc',
      action: 'flag',
      reason: 'flag',
      createdAt: new Date(NOW - 20 * 60 * 1000),
      lifeScore: 5,
      features: { speedOverG: 2 },
    });
    const supervisor = await boot(draft);
    await seen(supervisor);
    await feed(supervisor, draft, speedLife());
    expect(
      draft.memory.evidence.map((row) => [row.action, row.reason]),
    ).toEqual([
      ['flag', 'flag'],
      ['suppressed', 'cooldown'],
    ]);
    expect(draft.cards).toHaveLength(0);
    const later = await draft.memory.store.loadCaps({
      serverAlias: 'default',
      profileKey: 'guid:abc',
      now: new Date(NOW + 21 * 60 * 1000),
      cooldownMs: 30 * 60 * 1000,
    });
    expect(later.cooldownActive).toBe(false);
  });

  it('stays stopped when watch migrate fails and does not exit', async () => {
    const draft = draftHarness();
    draft.servers.push(enabled());
    const supervisor = await startWatchSupervisor({
      ...depsFor(draft),
      watchStore: undefined,
      migrate: async () => {
        throw new Error('watch schema failed');
      },
    });
    stopped.push(supervisor);
    expect(supervisor.running).toBe(false);
    await expect(supervisor.sync()).resolves.toBeUndefined();
    expect(draft.spawn).not.toHaveBeenCalled();
    expect(draft.exit).not.toHaveBeenCalled();
  });

  it('drops a life when the fresh status has no row for that slot', async () => {
    const life = await snapshotLife();
    expect(life['endReason']).toBe('disconnect');
    expect(life['slot']).toBe(PLAYER.num);

    const dropped = draftHarness();
    dropped.servers.push(enabled({ mode: 'flag' }));
    dropped.rcon.getStatus.mockResolvedValue(OPEN);
    const supervisor = await boot(dropped);
    supervisor.noteStatus('default', { raw: '', players: [] }, NOW);
    await supervisor.whenIdle();
    await feed(supervisor, dropped, life);
    expect(dropped.memory.lives).toHaveLength(0);

    supervisor.noteStatus(
      'default',
      {
        raw: '',
        mapName: 'mp_toujane',
        players: [{ ...PLAYER, guid: 'zzz', name: 'Next' }],
      },
      NOW,
    );
    await supervisor.whenIdle();
    expect(dropped.memory.lives).toHaveLength(0);
  });

  it('keeps a life while status is stale, then binds the row that arrives', async () => {
    const life = await snapshotLife();
    const draft = draftHarness();
    draft.servers.push(enabled({ mode: 'off' }));
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    const supervisor = await boot(draft);
    supervisor.noteStatus('default', { raw: '', players: [] }, NOW - 11_000);
    await supervisor.whenIdle();
    await feed(supervisor, draft, life);
    expect(draft.memory.lives).toHaveLength(0);
    await seen(supervisor);
    expect(draft.memory.lives).toHaveLength(1);
    expect(draft.memory.lives[0]?.profileKey).toBe('guid:abc');
  });

  it('does not kick when three recent lives sit between flagZ and kickZ', async () => {
    const draft = draftHarness();
    draft.servers.push(
      enabled({
        mode: 'kick',
        confirmedAimFeatures: 2,
        kickExtremeLives: 3,
        kickMinSessionLives: 1,
        minSelfLives: 8,
        minFeatureN: 5000,
      }),
    );
    draft.rcon.getStatus.mockResolvedValue(OPEN);
    const wide = { n: 5000, mean: 0, m2: 4999 };
    draft.memory.moments.set('snapOnAcquire', wide);
    draft.memory.moments.set('firedWhileLookingAway', wide);
    const self = { n: 8, mean: 0, m2: 7 };
    draft.memory.profiles.set('guid:abc', {
      serverAlias: 'default',
      profileKey: 'guid:abc',
      kind: 'guid',
      displayName: 'Cheater',
      lastGuid: 'abc',
      lastIp: PLAYER.ip ?? null,
      lifeCount: 8,
      selfMoments: { snapOnAcquire: self, firedWhileLookingAway: self },
      lastSeenAt: new Date(NOW),
    });
    for (const lifeScore of [4.5, 5, 5.5]) {
      await draft.memory.store.recordLife({
        serverAlias: 'default',
        profileKey: 'guid:abc',
        kind: 'guid',
        displayName: 'Cheater',
        mapName: 'mp_toujane',
        endReason: 'death',
        startedAt: new Date(NOW - 10_000),
        endedAt: new Date(NOW - 5_000),
        features: { snapOnAcquire: lifeScore },
        lifeScore,
        featuresOverFlag: 1,
        aimAgreeing: 0,
        excludedFromPopulation: true,
      });
    }
    const supervisor = await boot(draft);
    await seen(supervisor);
    await feed(supervisor, draft, kickLife());
    expect(draft.rcon.kick).not.toHaveBeenCalled();
    expect(draft.memory.evidence.map((row) => row.action)).toEqual(['report']);
  });
});

async function armed(
  mode: 'flag' | 'kick',
  setup: {
    players?: StatusPlayer[];
    profileKey?: string;
    kind?: WatchIdentityKind;
    lastGuid?: string | null;
    names?: number;
    /** Before boot: observeStatus replaces `rcon.status` with a wrapper. */
    prepare?: (draft: Draft) => void;
  } = {},
): Promise<{
  draft: Draft;
  supervisor: WatchSupervisor;
}> {
  const draft = draftHarness();
  draft.servers.push(
    enabled({
      mode,
      confirmedAimFeatures: 2,
      kickExtremeLives: 1,
      kickMinSessionLives: 1,
      minSelfLives: 8,
      minFeatureN: 5000,
    }),
  );
  draft.rcon.getStatus.mockResolvedValue(OPEN);
  const wide = { n: 5000, mean: 0, m2: 4999 };
  draft.memory.moments.set('snapOnAcquire', wide);
  draft.memory.moments.set('firedWhileLookingAway', wide);
  const self = { n: 8, mean: 0, m2: 7 };
  const profileKey = setup.profileKey ?? 'guid:abc';
  const kind = setup.kind ?? 'guid';
  draft.memory.nameCount.value = setup.names ?? 1;
  draft.memory.profiles.set(profileKey, {
    serverAlias: 'default',
    profileKey,
    kind,
    displayName: 'Cheater',
    lastGuid: setup.lastGuid === undefined ? 'abc' : setup.lastGuid,
    lastIp: PLAYER.ip ?? null,
    lifeCount: 8,
    selfMoments: { snapOnAcquire: self, firedWhileLookingAway: self },
    lastSeenAt: new Date(NOW),
  });
  setup.prepare?.(draft);
  const supervisor = await boot(draft);
  await seen(supervisor, setup.players ?? [PLAYER]);
  return { draft, supervisor };
}

async function seen(
  supervisor: WatchSupervisor,
  players: StatusPlayer[] = [PLAYER],
): Promise<void> {
  supervisor.noteStatus(
    'default',
    { raw: '', mapName: 'mp_toujane', players },
    NOW,
  );
  await supervisor.whenIdle();
}

async function feed(
  supervisor: WatchSupervisor,
  draft: Draft,
  life: Record<string, unknown>,
): Promise<void> {
  const child = draft.children[0];
  expect(child).toBeDefined();
  child!.stdout.write(`${JSON.stringify(life)}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  await supervisor.whenIdle();
}

/** A disconnect life produced by the child from `samplesFromSnapshot`. */
async function snapshotLife(): Promise<Record<string, unknown>> {
  const stdin = new PassThrough();
  const lines: string[] = [];
  let snap: ((samples: Sample[]) => void) | undefined;
  const child = createWatchChild({
    stdin,
    stdout: {
      write(chunk: string) {
        lines.push(String(chunk));
        return true;
      },
    },
    connect: async (options) => {
      snap = options.onSnapshot;
      return { disconnect() {}, run() {} };
    },
  });
  try {
    stdin.write(
      `${JSON.stringify({
        type: 'hello',
        servers: [
          {
            alias: 'default',
            host: '127.0.0.1',
            port: 28960,
            spectatorName: 'AdminWatch',
            protocol: 118,
            gSpeed: 190,
          },
        ],
      })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    if (!snap) {
      throw new Error('child did not connect');
    }
    const shoot = snap;
    for (const serverTimeMs of [0, 500, 1100]) {
      shoot(
        samplesFromSnapshot(
          [watchedPlayer(serverTimeMs)],
          serverTimeMs,
          'default',
        ),
      );
    }
    shoot([]);
    stdin.write(
      `${JSON.stringify({
        type: 'confirm',
        serverAlias: 'default',
        mapName: null,
      })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const parsed = lines
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const life = parsed.find((row) => row['slot'] === PLAYER.num);
    if (!life) {
      throw new Error('child did not emit a life');
    }
    return life;
  } finally {
    child.stop();
  }
}

function watchedPlayer(serverTimeMs: number): EntityObservation {
  return {
    serverTimeMs,
    entityNum: PLAYER.num,
    eType: 1,
    clientNum: PLAYER.num,
    origin: [serverTimeMs, 0, 0],
    velocity: [400, 0, 0],
    viewangles: [0, 0, 0],
    weapon: 0,
  };
}

function speedLife(): Record<string, unknown> {
  return {
    type: 'life',
    serverAlias: 'default',
    slot: PLAYER.num,
    endReason: 'death',
    strippedName: 'ignored',
    startedAtMs: NOW - 1000,
    endedAtMs: NOW,
    features: { speedOverG: 20 },
  };
}

function kickLife(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...speedLife(),
    features: { snapOnAcquire: 20, firedWhileLookingAway: 20 },
    ...extra,
  };
}

function messages(child: FakeChild): Record<string, unknown>[] {
  return child
    .text()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    alias: 'default',
    rconHost: '127.0.0.1',
    rconPort: 28960,
    rconPassword: RCON_SECRET,
    logSourceConfig: null,
    boundTelegramChatId: -100,
    isDefault: true,
    watch: null,
    watchPrivatePassword: null,
    watchPrivatePasswordOwned: false,
    ...overrides,
  };
}

function enabled(
  watch: Partial<ServerWatchSettings> = {},
  serverOverrides: Partial<ServerConfig> = {},
): ServerConfig {
  return server({
    watch: {
      ...DEFAULT_SERVER_WATCH_SETTINGS,
      enabled: true,
      mode: 'flag',
      ...watch,
    },
    ...serverOverrides,
  });
}

function draftHarness(): Draft {
  const adminStore = createFakeAdminStore();
  const rcon = createFakeRcon();
  const rcons = new Map<string, FakeRcon>([['default', rcon]]);
  const servers: ServerConfig[] = [];
  adminStore.listServers.mockImplementation(async () => servers);
  adminStore.getServer.mockImplementation(async (alias: string) =>
    servers.find((row) => row.alias === alias),
  );
  const children: FakeChild[] = [];
  const spawn = vi.fn<WatchSpawn>(() => {
    let text = '';
    let killed = false;
    let onExit:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child: FakeChild = {
      stdin: {
        write(chunk: string) {
          text += chunk;
          return true;
        },
      },
      stdout,
      stderr,
      pid: 2_147_483_000 + children.length,
      get killed() {
        return killed;
      },
      kill() {
        if (killed) {
          return true;
        }
        killed = true;
        onExit?.(0, 'SIGTERM');
        stdout.end();
        return true;
      },
      on(event, listener) {
        if (event === 'exit') {
          onExit = listener;
        }
      },
      text: () => text,
    };
    children.push(child);
    return child;
  });
  const draft: Draft = {
    adminStore,
    banStore: createFakeBanStore(),
    rcon,
    rcons,
    servers,
    memory: memoryStore(),
    children,
    spawn,
    cards: [],
    warnings: [],
    antiSpam: new ReportAntiSpam<string>({ now: () => NOW }),
    exit: vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never),
    nowMs: NOW,
  };
  drafts.push(draft);
  return draft;
}

async function boot(draft: Draft): Promise<WatchSupervisor> {
  vi.spyOn(draft.antiSpam, 'check');
  vi.spyOn(draft.antiSpam, 'resolve');
  vi.spyOn(draft.antiSpam, 'track');
  const supervisor = await startWatchSupervisor(depsFor(draft));
  stopped.push(supervisor);
  return supervisor;
}

function depsFor(draft: Draft) {
  return {
    databaseUrl: 'postgres://unused',
    adminStore: draft.adminStore,
    banStore: draft.banStore,
    rconClients: draft.rcons,
    watchStore: draft.memory.store,
    migrate: async () => undefined,
    spawn: draft.spawn,
    now: () => draft.nowMs,
    reportQueue: new ReportQueue(draft.adminStore),
    createCardSender: () => ({
      async send(_chatId: number, card: { text: string }) {
        draft.cards.push(card.text);
        return 'card';
      },
      async update() {
        return undefined;
      },
    }),
    log: {
      warn(message: string) {
        draft.warnings.push(message);
      },
      error(message: string) {
        draft.warnings.push(message);
      },
    },
    pruneIntervalMs: 0,
    killGroup: () => {
      const error = new Error('no such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    },
  };
}

function memoryStore(): Memory {
  const lives: RecordLifeInput[] = [];
  const evidence: RecordEvidenceInput[] = [];
  const profiles = new Map<string, WatchProfile>();
  const moments = new Map<string, PopulationMoments>();
  const nameCount = { value: 1 };
  let reads = 0;
  const empty = { n: 0, mean: 0, m2: 0 };
  const store: WatchStore = {
    async recordLife(input) {
      lives.push(input);
    },
    async upsertProfileName() {
      return undefined;
    },
    async distinctNames24h() {
      return nameCount.value;
    },
    async getProfile(_alias, key) {
      return profiles.get(key);
    },
    async populationMoments(query) {
      reads += 1;
      return moments.get(query.feature) ?? empty;
    },
    async populationZ() {
      return undefined;
    },
    async recordEvidence(input) {
      evidence.push(input);
      return `ev-${evidence.length}`;
    },
    async loadCaps(input) {
      const hourAgo = input.now.getTime() - HOUR_MS;
      const cooldownSince = input.now.getTime() - input.cooldownMs;
      let cardsThisHour = 0;
      let kickedThisHour = 0;
      let cooldownActive = false;
      for (const row of evidence) {
        if (row.serverAlias !== input.serverAlias) {
          continue;
        }
        const at = row.createdAt.getTime();
        if (row.action === 'kick' && at >= hourAgo) {
          kickedThisHour += 1;
        }
        const counts =
          row.action === 'flag' ||
          row.action === 'report' ||
          row.action === 'kick';
        if (!counts) {
          continue;
        }
        if (at >= hourAgo) {
          cardsThisHour += 1;
        }
        if (row.profileKey === input.profileKey && at >= cooldownSince) {
          cooldownActive = true;
        }
      }
      return { cardsThisHour, kickedThisHour, cooldownActive };
    },
    async recentLives(alias, key, limit) {
      return lives
        .filter((life) => life.serverAlias === alias && life.profileKey === key)
        .slice(-limit)
        .reverse()
        .map((life) => ({ lifeScore: life.lifeScore, endedAt: life.endedAt }));
    },
    async pruneWatchRetention() {
      return undefined;
    },
    async close() {
      return undefined;
    },
  };
  return {
    store,
    lives,
    evidence,
    profiles,
    moments,
    populationReads: () => reads,
    nameCount,
  };
}
