import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { SelfMoments, WatchLifeFeatures } from './types.js';

/** One identity per server. `selfMoments` is all-time and is not rebuilt by retention. */
export const watchProfiles = pgTable(
  'watch_profiles',
  {
    serverAlias: text('server_alias').notNull(),
    profileKey: text('profile_key').notNull(),
    kind: text('kind').notNull(),
    displayName: text('display_name'),
    lastGuid: text('last_guid'),
    lastIp: text('last_ip'),
    lifeCount: integer('life_count').notNull().default(0),
    selfMoments: jsonb('self_moments')
      .$type<SelfMoments>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.serverAlias, table.profileKey] })],
);

/**
 * Stripped names seen on a profile. The 24-hour shared-IP count is a read of `lastSeenAt`,
 * not a counter that retention resets.
 */
export const watchProfileNames = pgTable(
  'watch_profile_names',
  {
    serverAlias: text('server_alias').notNull(),
    profileKey: text('profile_key').notNull(),
    strippedName: text('stripped_name').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.serverAlias, table.profileKey, table.strippedName],
    }),
  ],
);

export const watchLives = pgTable(
  'watch_lives',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    serverAlias: text('server_alias').notNull(),
    profileKey: text('profile_key').notNull(),
    /** Null: the life is stored, but it has no population bucket and no self-moment update. */
    mapName: text('map_name'),
    endReason: text('end_reason').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    features: jsonb('features').$type<WatchLifeFeatures>().notNull(),
    lifeScore: real('life_score'),
    featuresOverFlag: integer('features_over_flag').notNull(),
    aimAgreeing: integer('aim_agreeing').notNull(),
    /** True when the life was flagged, or when `mapName` is null. Those lives are not merged. */
    excludedFromPopulation: boolean('excluded_from_population').notNull(),
  },
  (table) => [
    index('watch_lives_server_ended_idx').on(table.serverAlias, table.endedAt),
    index('watch_lives_server_profile_ended_idx').on(
      table.serverAlias,
      table.profileKey,
      table.endedAt,
    ),
  ],
);

/** Per-day Welford bucket. Weapon class stays `all` until a weapon id exists. No all-time row. */
export const watchPopulationDays = pgTable(
  'watch_population_days',
  {
    serverAlias: text('server_alias').notNull(),
    mapName: text('map_name').notNull(),
    weaponClass: text('weapon_class').notNull(),
    feature: text('feature').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    n: integer('n').notNull(),
    mean: doublePrecision('mean').notNull(),
    m2: doublePrecision('m2').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.serverAlias,
        table.mapName,
        table.weaponClass,
        table.feature,
        table.day,
      ],
    }),
  ],
);

export const watchEvidence = pgTable(
  'watch_evidence',
  {
    id: uuid('id').primaryKey(),
    serverAlias: text('server_alias').notNull(),
    profileKey: text('profile_key').notNull(),
    action: text('action').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lifeScore: real('life_score').notNull(),
    features: jsonb('features').$type<WatchLifeFeatures>().notNull(),
    trace: jsonb('trace'),
    reportId: integer('report_id'),
  },
  (table) => [
    index('watch_evidence_server_created_idx').on(
      table.serverAlias,
      table.createdAt,
    ),
    index('watch_evidence_server_profile_created_idx').on(
      table.serverAlias,
      table.profileKey,
      table.createdAt,
    ),
  ],
);
