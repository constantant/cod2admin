import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { createWatchStore } from './store.js';
import type { RecordLifeInput, WatchStore } from './types.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://cod2admin:dev_password_change_me@127.0.0.1:5432/cod2admin_dev';

const SERVER = 'ctf';
const NOW = new Date('2026-11-10T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

describe('watch-store', () => {
  let store: WatchStore;
  let pool: Pool;

  beforeAll(async () => {
    await migrate(DATABASE_URL);
    await migrate(DATABASE_URL);
    store = createWatchStore(DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await store.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE watch_profiles, watch_profile_names, watch_lives, watch_population_days, watch_evidence RESTART IDENTITY',
    );
  });

  async function countRows(table: string): Promise<number> {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table}`,
    );
    return result.rows[0].n;
  }

  function life(
    overrides: Partial<RecordLifeInput> &
      Pick<RecordLifeInput, 'profileKey' | 'endedAt'>,
  ): RecordLifeInput {
    return {
      serverAlias: SERVER,
      kind: 'ip',
      mapName: 'mp_toujane',
      endReason: 'death',
      startedAt: new Date(overrides.endedAt.getTime() - 60_000),
      features: { speedOverG: 1 },
      lifeScore: 0,
      featuresOverFlag: 0,
      aimAgreeing: 0,
      excludedFromPopulation: false,
      ...overrides,
    };
  }

  async function recordValues(
    profileKey: string,
    mapName: string | null,
    values: number[],
    endedAt: Date,
    excluded = false,
  ): Promise<void> {
    for (const value of values) {
      await store.recordLife(
        life({
          profileKey,
          mapName,
          endedAt,
          excludedFromPopulation: excluded,
          features: { speedOverG: value },
          lifeScore: excluded ? 8 : 0,
          featuresOverFlag: excluded ? 1 : 0,
        }),
      );
    }
  }

  describe('migration', () => {
    it('applies on Postgres and leaves map_name nullable', async () => {
      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name LIKE 'watch_%'
         ORDER BY table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        'watch_evidence',
        'watch_lives',
        'watch_population_days',
        'watch_profile_names',
        'watch_profiles',
      ]);

      const mapName = await pool.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'watch_lives' AND column_name = 'map_name'`,
      );
      expect(mapName.rows[0].is_nullable).toBe('YES');

      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename IN ('watch_lives', 'watch_evidence')
         ORDER BY indexname`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          'watch_lives_server_ended_idx',
          'watch_lives_server_profile_ended_idx',
          'watch_evidence_server_created_idx',
          'watch_evidence_server_profile_created_idx',
        ]),
      );

      const journal = await pool.query<{ ok: boolean }>(
        `SELECT to_regclass('drizzle.watch_store_migrations') IS NOT NULL AS ok`,
      );
      expect(journal.rows[0].ok).toBe(true);
    });
  });

  describe('lives', () => {
    it('stores a null map without population or self moments', async () => {
      await store.recordLife(
        life({
          profileKey: 'ip:10.0.0.1',
          mapName: null,
          excludedFromPopulation: false,
          endedAt: NOW,
          features: { snapOnAcquire: 40, speedOverG: 3 },
          displayName: 'NullMap',
        }),
      );

      const stored = await pool.query<{
        map_name: string | null;
        excluded_from_population: boolean;
      }>(
        `SELECT map_name, excluded_from_population FROM watch_lives WHERE profile_key = 'ip:10.0.0.1'`,
      );
      expect(stored.rows).toEqual([
        { map_name: null, excluded_from_population: true },
      ]);
      expect(await countRows('watch_population_days')).toBe(0);
      await expect(
        store.getProfile(SERVER, 'ip:10.0.0.1'),
      ).resolves.toMatchObject({
        lifeCount: 0,
        selfMoments: {},
        displayName: 'NullMap',
      });
    });

    it('stores a flagged life and does not merge it', async () => {
      await store.recordLife(
        life({
          profileKey: 'ip:10.0.0.2',
          endedAt: NOW,
          excludedFromPopulation: true,
          lifeScore: 5,
          featuresOverFlag: 1,
          features: { speedOverG: 9 },
        }),
      );

      expect(await countRows('watch_lives')).toBe(1);
      expect(await countRows('watch_population_days')).toBe(0);
      await expect(
        store.getProfile(SERVER, 'ip:10.0.0.2'),
      ).resolves.toMatchObject({
        lifeCount: 0,
        selfMoments: {},
      });
    });

    it('folds non-excluded mapped lives into self moments and life_count', async () => {
      await store.recordLife(
        life({
          profileKey: 'guid:42',
          kind: 'guid',
          endedAt: new Date('2026-11-09T10:00:00.000Z'),
          features: { speedOverG: 0, snapOnAcquire: 10 },
          lastGuid: '42',
          displayName: 'Regular',
        }),
      );
      await store.recordLife(
        life({
          profileKey: 'guid:42',
          kind: 'guid',
          endedAt: new Date('2026-11-09T12:00:00.000Z'),
          features: { speedOverG: 4 },
          displayName: 'Regular',
        }),
      );
      await store.recordLife(
        life({
          profileKey: 'guid:42',
          kind: 'guid',
          endedAt: new Date(NOW.getTime() - 2 * DAY_MS),
          excludedFromPopulation: true,
          features: { speedOverG: 100 },
        }),
      );

      const profile = await store.getProfile(SERVER, 'guid:42');
      expect(profile).toMatchObject({
        kind: 'guid',
        lifeCount: 2,
        lastGuid: '42',
        displayName: 'Regular',
      });
      expect(profile?.selfMoments.speedOverG).toEqual({ n: 2, mean: 2, m2: 8 });
      expect(profile?.selfMoments.snapOnAcquire).toEqual({
        n: 1,
        mean: 10,
        m2: 0,
      });
      expect(profile?.lastSeenAt.toISOString()).toBe(
        '2026-11-09T12:00:00.000Z',
      );

      const days = await pool.query<{
        feature: string;
        n: number;
        mean: number;
        m2: number;
        weapon_class: string;
      }>(
        `SELECT feature, n, mean, m2, weapon_class FROM watch_population_days
         WHERE server_alias = $1
         ORDER BY feature`,
        [SERVER],
      );
      expect(days.rows).toEqual([
        {
          feature: 'snapOnAcquire',
          n: 1,
          mean: 10,
          m2: 0,
          weapon_class: 'all',
        },
        { feature: 'speedOverG', n: 2, mean: 2, m2: 8, weapon_class: 'all' },
      ]);
    });

    it('rejects a profile key that does not match its kind', async () => {
      await expect(
        store.recordLife(
          life({ profileKey: 'guid:1', kind: 'ip', endedAt: NOW }),
        ),
      ).rejects.toThrow(/profileKey/);
      expect(await countRows('watch_lives')).toBe(0);
    });
  });

  describe('population', () => {
    it('merges the last 14 days and ignores excluded, null-map, and older days', async () => {
      const key = 'ip:10.1.0.1';
      const mapName = 'mp_toujane';
      await recordValues(
        key,
        mapName,
        Array.from({ length: 20 }, () => 0),
        new Date('2026-11-08T12:00:00.000Z'),
      );
      await recordValues(
        key,
        mapName,
        Array.from({ length: 20 }, () => 4),
        new Date('2026-11-09T12:00:00.000Z'),
      );
      await recordValues(
        key,
        mapName,
        [100],
        new Date('2026-11-09T18:00:00.000Z'),
        true,
      );
      await recordValues(key, null, [100], NOW);
      await recordValues(
        key,
        mapName,
        Array.from({ length: 20 }, () => 100),
        new Date('2026-10-26T12:00:00.000Z'),
      );
      await recordValues(
        'ip:10.1.0.2',
        'mp_other',
        Array.from({ length: 30 }, () => 50),
        NOW,
      );

      const moments = await store.populationMoments({
        serverAlias: SERVER,
        mapName,
        feature: 'speedOverG',
        now: NOW,
      });
      expect(moments).toEqual({ n: 40, mean: 2, m2: 160 });

      const z = await store.populationZ({
        serverAlias: SERVER,
        mapName,
        feature: 'speedOverG',
        now: NOW,
        value: 4,
      });
      expect(z).toBeCloseTo(2 / Math.sqrt(160 / 39), 8);
      await expect(store.getProfile(SERVER, key)).resolves.toMatchObject({
        lifeCount: 60,
      });

      const dayBeforeWindow = await pool.query<{ n: string }>(
        `SELECT coalesce(sum(n), 0)::text AS n FROM watch_population_days
         WHERE map_name = $1 AND feature = 'speedOverG' AND day = '2026-10-26'`,
        [mapName],
      );
      expect(dayBeforeWindow.rows[0].n).toBe('20');
      await expect(
        store.populationMoments({
          serverAlias: SERVER,
          mapName,
          feature: 'speedOverG',
          now: new Date('2026-10-26T12:00:00.000Z'),
        }),
      ).resolves.toEqual({ n: 20, mean: 100, m2: 0 });
    });

    it('contributes nothing when merged n is below 30 or m2 is 0', async () => {
      await recordValues(
        'ip:10.2.0.1',
        'mp_small',
        [...Array.from({ length: 28 }, () => 0), 4],
        NOW,
      );
      await recordValues(
        'ip:10.2.0.2',
        'mp_flat',
        Array.from({ length: 30 }, () => 1),
        NOW,
      );

      await expect(
        store.populationZ({
          serverAlias: SERVER,
          mapName: 'mp_small',
          feature: 'speedOverG',
          now: NOW,
          value: 4,
        }),
      ).resolves.toBeUndefined();
      const flat = await store.populationMoments({
        serverAlias: SERVER,
        mapName: 'mp_flat',
        feature: 'speedOverG',
        now: NOW,
      });
      expect(flat).toEqual({ n: 30, mean: 1, m2: 0 });
      await expect(
        store.populationZ({
          serverAlias: SERVER,
          mapName: 'mp_flat',
          feature: 'speedOverG',
          now: NOW,
          value: 1,
        }),
      ).resolves.toBeUndefined();
    });

    it('keeps the UTC day of the 14-day cutoff inside the window', async () => {
      await recordValues(
        'ip:10.3.0.1',
        'mp_edge',
        [2],
        new Date('2026-10-27T00:00:00.000Z'),
      );
      await recordValues(
        'ip:10.3.0.1',
        'mp_edge',
        [2],
        new Date('2026-10-26T23:00:00.000Z'),
      );

      const moments = await store.populationMoments({
        serverAlias: SERVER,
        mapName: 'mp_edge',
        feature: 'speedOverG',
        now: NOW,
      });
      expect(moments.n).toBe(1);
    });
  });

  describe('names', () => {
    it('counts distinct stripped names seen in the last 24 hours', async () => {
      const key = 'ip:10.4.0.1';
      await store.upsertProfileName({
        serverAlias: SERVER,
        profileKey: key,
        strippedName: 'PlayerOne',
        seenAt: new Date(NOW.getTime() - 23 * HOUR_MS),
      });
      await store.upsertProfileName({
        serverAlias: SERVER,
        profileKey: key,
        strippedName: 'PlayerOne',
        seenAt: NOW,
      });
      await store.upsertProfileName({
        serverAlias: SERVER,
        profileKey: key,
        strippedName: 'Other',
        seenAt: new Date(NOW.getTime() - 25 * HOUR_MS),
      });
      await store.upsertProfileName({
        serverAlias: SERVER,
        profileKey: key,
        strippedName: 'Other',
        seenAt: new Date(NOW.getTime() - 30 * HOUR_MS),
      });

      expect(await store.distinctNames24h(SERVER, key, NOW)).toBe(1);
      expect(await countRows('watch_profile_names')).toBe(2);

      const seen = await pool.query<{
        stripped_name: string;
        last_seen_at: Date;
      }>(
        `SELECT stripped_name, last_seen_at FROM watch_profile_names
         WHERE profile_key = $1 AND stripped_name = 'Other'`,
        [key],
      );
      expect(seen.rows[0].last_seen_at.toISOString()).toBe(
        new Date(NOW.getTime() - 25 * HOUR_MS).toISOString(),
      );

      await store.upsertProfileName({
        serverAlias: SERVER,
        profileKey: key,
        strippedName: 'Exact',
        seenAt: new Date(NOW.getTime() - DAY_MS),
      });
      await store.upsertProfileName({
        serverAlias: SERVER,
        profileKey: key,
        strippedName: 'JustOut',
        seenAt: new Date(NOW.getTime() - DAY_MS - 1),
      });
      expect(await store.distinctNames24h(SERVER, key, NOW)).toBe(2);

      await store.upsertProfileName({
        serverAlias: 'other',
        profileKey: key,
        strippedName: 'Elsewhere',
        seenAt: NOW,
      });
      expect(await store.distinctNames24h(SERVER, key, NOW)).toBe(2);
    });
  });

  describe('retention', () => {
    it('drops lives and population days after 14 days and evidence after 90 days', async () => {
      const key = 'hwid:99';
      await store.recordLife(
        life({
          profileKey: key,
          kind: 'hwid',
          mapName: 'mp_toujane',
          endedAt: new Date('2026-10-26T12:00:00.000Z'),
          features: { speedOverG: 1 },
        }),
      );
      await store.recordLife(
        life({
          profileKey: key,
          kind: 'hwid',
          endedAt: new Date('2026-10-27T11:59:59.999Z'),
          features: { speedOverG: 1 },
        }),
      );
      await store.recordLife(
        life({
          profileKey: key,
          kind: 'hwid',
          endedAt: new Date('2026-10-27T12:00:00.000Z'),
          features: { speedOverG: 1 },
        }),
      );
      await store.recordLife(
        life({
          profileKey: key,
          kind: 'hwid',
          endedAt: new Date('2026-11-09T12:00:00.000Z'),
          features: { speedOverG: 3 },
        }),
      );

      const ninety = 90 * DAY_MS;
      await store.recordEvidence({
        serverAlias: SERVER,
        profileKey: key,
        action: 'flag',
        reason: 'old',
        createdAt: new Date(NOW.getTime() - ninety - 1),
        lifeScore: 4,
        features: { speedOverG: 3 },
      });
      await store.recordEvidence({
        serverAlias: SERVER,
        profileKey: key,
        action: 'report',
        reason: 'edge',
        createdAt: new Date(NOW.getTime() - ninety),
        lifeScore: 4,
        features: { speedOverG: 3 },
      });
      await store.recordEvidence({
        serverAlias: SERVER,
        profileKey: key,
        action: 'suppressed',
        reason: 'recent',
        createdAt: NOW,
        lifeScore: 4,
        features: { speedOverG: 3 },
        trace: null,
      });
      await store.upsertProfileName({
        serverAlias: SERVER,
        profileKey: key,
        strippedName: 'Stale',
        seenAt: new Date(NOW.getTime() - 25 * HOUR_MS),
      });

      const before = await store.getProfile(SERVER, key);
      expect(before?.lifeCount).toBe(4);

      await store.pruneWatchRetention(NOW);

      const lives = await pool.query<{ ended_at: Date }>(
        `SELECT ended_at FROM watch_lives WHERE profile_key = $1 ORDER BY ended_at`,
        [key],
      );
      expect(lives.rows.map((row) => row.ended_at.toISOString())).toEqual([
        '2026-10-27T12:00:00.000Z',
        '2026-11-09T12:00:00.000Z',
      ]);

      const days = await pool.query<{ day: string }>(
        `SELECT day::text AS day FROM watch_population_days WHERE server_alias = $1 ORDER BY day`,
        [SERVER],
      );
      expect(days.rows.map((row) => row.day)).toEqual([
        '2026-10-27',
        '2026-11-09',
      ]);

      const evidence = await pool.query<{ reason: string }>(
        `SELECT reason FROM watch_evidence WHERE profile_key = $1 ORDER BY created_at`,
        [key],
      );
      expect(evidence.rows.map((row) => row.reason)).toEqual([
        'edge',
        'recent',
      ]);

      const profile = await store.getProfile(SERVER, key);
      expect(profile?.lifeCount).toBe(4);
      expect(profile?.selfMoments.speedOverG?.n).toBe(4);
      expect(await countRows('watch_profiles')).toBe(1);
      expect(await store.distinctNames24h(SERVER, key, NOW)).toBe(0);
      expect(await countRows('watch_profile_names')).toBe(1);
    });
  });
});
