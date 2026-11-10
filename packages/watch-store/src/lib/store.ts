import { randomUUID } from 'node:crypto';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  watchEvidence,
  watchLives,
  watchPopulationDays,
  watchProfileNames,
  watchProfiles,
} from './schema.js';
import type {
  PopulationMoments,
  PopulationQuery,
  RecordEvidenceInput,
  RecordLifeInput,
  SelfMoments,
  UpsertProfileNameInput,
  WatchEndReason,
  WatchEvidenceAction,
  WatchFeature,
  WatchIdentityKind,
  WatchLifeFeatures,
  WatchProfile,
  WatchStore,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LIFE_RETENTION_MS = 14 * DAY_MS;
const EVIDENCE_RETENTION_MS = 90 * DAY_MS;
const NAME_WINDOW_MS = DAY_MS;
/** Below this many merged observations a z is noise, same gate as player-watch. */
const MIN_POPULATION_N = 30;
/** One bucket until the collector records a weapon id. */
const WEAPON_CLASS_ALL = 'all';

const WATCH_FEATURES: readonly WatchFeature[] = [
  'snapOnAcquire',
  'firedWhileLookingAway',
  'viewErrorAtHit',
  'timeToDamageMs',
  'angularSpeedP95',
  'speedOverG',
];

const IDENTITY_KINDS: readonly WatchIdentityKind[] = ['hwid', 'guid', 'ip'];
const END_REASONS: readonly WatchEndReason[] = ['death', 'disconnect', 'map'];
const EVIDENCE_ACTIONS: readonly WatchEvidenceAction[] = [
  'flag',
  'report',
  'kick',
  'suppressed',
];

const EMPTY_MOMENTS: PopulationMoments = { n: 0, mean: 0, m2: 0 };

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid Date`);
  }
  return value;
}

function requireKind(value: string): WatchIdentityKind {
  if (!(IDENTITY_KINDS as readonly string[]).includes(value)) {
    throw new Error(`kind must be one of ${IDENTITY_KINDS.join(', ')}`);
  }
  return value as WatchIdentityKind;
}

function requireEndReason(value: string): WatchEndReason {
  if (!(END_REASONS as readonly string[]).includes(value)) {
    throw new Error(`endReason must be one of ${END_REASONS.join(', ')}`);
  }
  return value as WatchEndReason;
}

function requireAction(value: string): WatchEvidenceAction {
  if (!(EVIDENCE_ACTIONS as readonly string[]).includes(value)) {
    throw new Error(`action must be one of ${EVIDENCE_ACTIONS.join(', ')}`);
  }
  return value as WatchEvidenceAction;
}

function requireFeature(value: string): WatchFeature {
  if (!(WATCH_FEATURES as readonly string[]).includes(value)) {
    throw new Error(`Unknown watch feature: ${value}`);
  }
  return value as WatchFeature;
}

function requireCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireFinite(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

/** UTC calendar day. Population buckets and the 14-day window are both whole days. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isMoments(value: unknown): value is PopulationMoments {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as PopulationMoments;
  return (
    Number.isFinite(row.n) &&
    row.n >= 0 &&
    Number.isFinite(row.mean) &&
    Number.isFinite(row.m2)
  );
}

function readSelfMoments(value: unknown): SelfMoments {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  const moments: SelfMoments = {};
  for (const feature of WATCH_FEATURES) {
    const entry = source[feature];
    if (!isMoments(entry) || entry.n <= 0) continue;
    moments[feature] = { n: entry.n, mean: entry.mean, m2: entry.m2 };
  }
  return moments;
}

function finiteFeatures(
  features: WatchLifeFeatures,
): Array<[WatchFeature, number]> {
  if (
    typeof features !== 'object' ||
    features === null ||
    Array.isArray(features)
  ) {
    throw new Error('features must be an object');
  }
  const found: Array<[WatchFeature, number]> = [];
  for (const feature of WATCH_FEATURES) {
    const value = features[feature];
    if (value === undefined) continue;
    found.push([feature, requireFinite(value, feature)]);
  }
  return found;
}

function featurePayload(features: WatchLifeFeatures): WatchLifeFeatures {
  const payload: WatchLifeFeatures = {};
  for (const [feature, value] of finiteFeatures(features)) {
    payload[feature] = value;
  }
  return payload;
}

/** Parallel Welford merge. A point is `{ n: 1, mean: value, m2: 0 }`. */
function mergeMoments(
  left: PopulationMoments,
  right: PopulationMoments,
): PopulationMoments {
  if (left.n <= 0) return { n: right.n, mean: right.mean, m2: right.m2 };
  if (right.n <= 0) return { n: left.n, mean: left.mean, m2: left.m2 };
  const n = left.n + right.n;
  const delta = right.mean - left.mean;
  return {
    n,
    mean: left.mean + (delta * right.n) / n,
    m2: left.m2 + right.m2 + (delta * delta * left.n * right.n) / n,
  };
}

function observe(
  moments: PopulationMoments | undefined,
  value: number,
): PopulationMoments {
  const base = moments && moments.n > 0 ? moments : { n: 0, mean: 0, m2: 0 };
  return mergeMoments(base, { n: 1, mean: value, m2: 0 });
}

/**
 * Sample standard deviation `sqrt(m2 / (n - 1))`.
 * `n < 30` or `m2 <= 0` contributes nothing.
 */
function zScore(value: number, moments: PopulationMoments): number | undefined {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(moments.n) ||
    !Number.isFinite(moments.mean) ||
    !Number.isFinite(moments.m2)
  ) {
    return undefined;
  }
  if (moments.n < MIN_POPULATION_N || moments.m2 <= 0) return undefined;
  const sd = Math.sqrt(moments.m2 / (moments.n - 1));
  if (!Number.isFinite(sd) || sd === 0) return undefined;
  return (value - moments.mean) / sd;
}

function optionalText(
  value: string | null | undefined,
  label: string,
): string | null {
  if (value == null) return null;
  return requireText(value, label);
}

/**
 * Deletes lives and population days older than 14 days, and evidence older than 90 days.
 * Profiles and name rows stay. Name expiry is the 24-hour read, not this delete.
 * The day of `now - 14 days` is kept: a population row is one UTC day, not an instant.
 */
async function deleteExpired(db: NodePgDatabase, now: Date): Promise<void> {
  const at = requireDate(now, 'now');
  const lifeCutoff = new Date(at.getTime() - LIFE_RETENTION_MS);
  const evidenceCutoff = new Date(at.getTime() - EVIDENCE_RETENTION_MS);
  const oldestDay = utcDay(lifeCutoff);
  await db.transaction(async (tx) => {
    await tx.delete(watchLives).where(lt(watchLives.endedAt, lifeCutoff));
    await tx
      .delete(watchPopulationDays)
      .where(sql`${watchPopulationDays.day} < ${oldestDay}::date`);
    await tx
      .delete(watchEvidence)
      .where(lt(watchEvidence.createdAt, evidenceCutoff));
  });
}

/** Retention scheduler body. Does not start a timer. */
export async function pruneWatchRetention(
  db: NodePgDatabase,
  now: Date,
): Promise<void> {
  await deleteExpired(db, now);
}

export class DrizzleWatchStore implements WatchStore {
  private readonly pool: Pool;
  private readonly db: NodePgDatabase;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    this.db = drizzle(this.pool);
  }

  async recordLife(input: RecordLifeInput): Promise<void> {
    const serverAlias = requireText(input.serverAlias, 'serverAlias');
    const kind = requireKind(input.kind);
    const profileKey = requireText(input.profileKey, 'profileKey');
    const prefix = `${kind}:`;
    if (!profileKey.startsWith(prefix) || profileKey.length === prefix.length) {
      throw new Error('profileKey must be the kind prefix plus an id');
    }
    const endReason = requireEndReason(input.endReason);
    const startedAt = requireDate(input.startedAt, 'startedAt');
    const endedAt = requireDate(input.endedAt, 'endedAt');
    const mapName =
      input.mapName === null ? null : requireText(input.mapName, 'mapName');
    const features = featurePayload(input.features);
    const observed = finiteFeatures(features);
    const lifeScore =
      input.lifeScore === null
        ? null
        : requireFinite(input.lifeScore, 'lifeScore');
    const featuresOverFlag = requireCount(
      input.featuresOverFlag,
      'featuresOverFlag',
    );
    const aimAgreeing = requireCount(input.aimAgreeing, 'aimAgreeing');
    if (typeof input.excludedFromPopulation !== 'boolean') {
      throw new Error('excludedFromPopulation must be a boolean');
    }
    // Null map is out of every window even if the caller left the flag false.
    const excluded = input.excludedFromPopulation || mapName === null;
    const merges = !excluded && mapName !== null;
    const displayName = optionalText(input.displayName, 'displayName');
    const lastGuid = optionalText(input.lastGuid, 'lastGuid');
    const lastIp = optionalText(input.lastIp, 'lastIp');
    const day = utcDay(endedAt);

    await this.db.transaction(async (tx) => {
      await tx
        .insert(watchProfiles)
        .values({
          serverAlias,
          profileKey,
          kind,
          displayName,
          lastGuid,
          lastIp,
          lifeCount: 0,
          selfMoments: {},
          lastSeenAt: endedAt,
        })
        .onConflictDoUpdate({
          target: [watchProfiles.serverAlias, watchProfiles.profileKey],
          set: {
            kind,
            ...(displayName !== null ? { displayName } : {}),
            ...(lastGuid !== null ? { lastGuid } : {}),
            ...(lastIp !== null ? { lastIp } : {}),
            lastSeenAt: sql`GREATEST(${watchProfiles.lastSeenAt}, ${endedAt})`,
          },
        });

      if (merges) {
        const [profile] = await tx
          .select({ selfMoments: watchProfiles.selfMoments })
          .from(watchProfiles)
          .where(
            and(
              eq(watchProfiles.serverAlias, serverAlias),
              eq(watchProfiles.profileKey, profileKey),
            ),
          )
          .for('update');
        if (!profile) {
          throw new Error('profile row missing after upsert');
        }
        const next = readSelfMoments(profile.selfMoments);
        for (const [feature, value] of observed) {
          next[feature] = observe(next[feature], value);
        }
        await tx
          .update(watchProfiles)
          .set({
            ...(observed.length > 0 ? { selfMoments: next } : {}),
            lifeCount: sql`${watchProfiles.lifeCount} + 1`,
          })
          .where(
            and(
              eq(watchProfiles.serverAlias, serverAlias),
              eq(watchProfiles.profileKey, profileKey),
            ),
          );

        for (const [feature, value] of observed) {
          await tx
            .insert(watchPopulationDays)
            .values({
              serverAlias,
              mapName,
              weaponClass: WEAPON_CLASS_ALL,
              feature,
              day,
              n: 1,
              mean: value,
              m2: 0,
            })
            .onConflictDoUpdate({
              target: [
                watchPopulationDays.serverAlias,
                watchPopulationDays.mapName,
                watchPopulationDays.weaponClass,
                watchPopulationDays.feature,
                watchPopulationDays.day,
              ],
              set: {
                n: sql`${watchPopulationDays.n} + 1`,
                mean: sql`${watchPopulationDays.mean} + (${value}::double precision - ${watchPopulationDays.mean}) / (${watchPopulationDays.n} + 1)`,
                m2: sql`${watchPopulationDays.m2} + ((${value}::double precision - ${watchPopulationDays.mean}) * (${value}::double precision - ${watchPopulationDays.mean}) * ${watchPopulationDays.n}) / (${watchPopulationDays.n} + 1)`,
              },
            });
        }
      }

      await tx.insert(watchLives).values({
        serverAlias,
        profileKey,
        mapName,
        endReason,
        startedAt,
        endedAt,
        features,
        lifeScore,
        featuresOverFlag,
        aimAgreeing,
        excludedFromPopulation: excluded,
      });
    });
  }

  async upsertProfileName(input: UpsertProfileNameInput): Promise<void> {
    const serverAlias = requireText(input.serverAlias, 'serverAlias');
    const profileKey = requireText(input.profileKey, 'profileKey');
    const strippedName = requireText(input.strippedName, 'strippedName');
    const seenAt = requireDate(input.seenAt, 'seenAt');
    await this.db
      .insert(watchProfileNames)
      .values({ serverAlias, profileKey, strippedName, lastSeenAt: seenAt })
      .onConflictDoUpdate({
        target: [
          watchProfileNames.serverAlias,
          watchProfileNames.profileKey,
          watchProfileNames.strippedName,
        ],
        set: {
          lastSeenAt: sql`GREATEST(${watchProfileNames.lastSeenAt}, ${seenAt})`,
        },
      });
  }

  async distinctNames24h(
    serverAlias: string,
    profileKey: string,
    now: Date,
  ): Promise<number> {
    const alias = requireText(serverAlias, 'serverAlias');
    const key = requireText(profileKey, 'profileKey');
    const at = requireDate(now, 'now');
    const since = new Date(at.getTime() - NAME_WINDOW_MS);
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(watchProfileNames)
      .where(
        and(
          eq(watchProfileNames.serverAlias, alias),
          eq(watchProfileNames.profileKey, key),
          gte(watchProfileNames.lastSeenAt, since),
        ),
      );
    const value = Number(row?.value ?? 0);
    if (!Number.isSafeInteger(value)) {
      throw new Error('distinctNames24h count was not an integer');
    }
    return value;
  }

  async getProfile(
    serverAlias: string,
    profileKey: string,
  ): Promise<WatchProfile | undefined> {
    const alias = requireText(serverAlias, 'serverAlias');
    const key = requireText(profileKey, 'profileKey');
    const [row] = await this.db
      .select()
      .from(watchProfiles)
      .where(
        and(
          eq(watchProfiles.serverAlias, alias),
          eq(watchProfiles.profileKey, key),
        ),
      );
    if (!row) return undefined;
    return {
      serverAlias: row.serverAlias,
      profileKey: row.profileKey,
      kind: requireKind(row.kind),
      displayName: row.displayName,
      lastGuid: row.lastGuid,
      lastIp: row.lastIp,
      lifeCount: row.lifeCount,
      selfMoments: readSelfMoments(row.selfMoments),
      lastSeenAt: row.lastSeenAt,
    };
  }

  async populationMoments(query: PopulationQuery): Promise<PopulationMoments> {
    const rows = await this.populationRows(query);
    let merged = EMPTY_MOMENTS;
    for (const row of rows) {
      const n = Number(row.n);
      const mean = Number(row.mean);
      const m2 = Number(row.m2);
      if (
        !Number.isFinite(n) ||
        n <= 0 ||
        !Number.isFinite(mean) ||
        !Number.isFinite(m2)
      ) {
        continue;
      }
      merged = mergeMoments(merged, { n, mean, m2 });
    }
    return merged;
  }

  async populationZ(
    query: PopulationQuery & { value: number },
  ): Promise<number | undefined> {
    if (typeof query.value !== 'number' || !Number.isFinite(query.value)) {
      return undefined;
    }
    return zScore(query.value, await this.populationMoments(query));
  }

  async recordEvidence(input: RecordEvidenceInput): Promise<void> {
    const serverAlias = requireText(input.serverAlias, 'serverAlias');
    const profileKey = requireText(input.profileKey, 'profileKey');
    const action = requireAction(input.action);
    const createdAt = requireDate(input.createdAt, 'createdAt');
    const lifeScore = requireFinite(input.lifeScore, 'lifeScore');
    const features = featurePayload(input.features);
    const reason =
      input.reason == null ? null : requireText(input.reason, 'reason');
    if (input.reportId != null && !Number.isSafeInteger(input.reportId)) {
      throw new Error('reportId must be an integer');
    }
    await this.db.insert(watchEvidence).values({
      id: randomUUID(),
      serverAlias,
      profileKey,
      action,
      reason,
      createdAt,
      lifeScore,
      features,
      trace: input.trace === undefined ? null : input.trace,
      reportId: input.reportId ?? null,
    });
  }

  async pruneWatchRetention(now: Date): Promise<void> {
    await deleteExpired(this.db, now);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async populationRows(query: PopulationQuery) {
    const serverAlias = requireText(query.serverAlias, 'serverAlias');
    const mapName = requireText(query.mapName, 'mapName');
    const feature = requireFeature(query.feature);
    const at = requireDate(query.now, 'now');
    const oldestDay = utcDay(new Date(at.getTime() - LIFE_RETENTION_MS));
    const newestDay = utcDay(at);
    return this.db
      .select({
        n: watchPopulationDays.n,
        mean: watchPopulationDays.mean,
        m2: watchPopulationDays.m2,
      })
      .from(watchPopulationDays)
      .where(
        and(
          eq(watchPopulationDays.serverAlias, serverAlias),
          eq(watchPopulationDays.mapName, mapName),
          eq(watchPopulationDays.weaponClass, WEAPON_CLASS_ALL),
          eq(watchPopulationDays.feature, feature),
          sql`${watchPopulationDays.day} >= ${oldestDay}::date AND ${watchPopulationDays.day} <= ${newestDay}::date`,
        ),
      );
  }
}

export function createWatchStore(connectionString: string): WatchStore {
  return new DrizzleWatchStore(connectionString);
}
