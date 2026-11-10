export type WatchFeature =
  | 'snapOnAcquire'
  | 'firedWhileLookingAway'
  | 'viewErrorAtHit'
  | 'timeToDamageMs'
  | 'angularSpeedP95'
  | 'speedOverG';

export type WatchIdentityKind = 'hwid' | 'guid' | 'ip';

export type WatchEndReason = 'death' | 'disconnect' | 'map';

export type WatchEvidenceAction = 'flag' | 'report' | 'kick' | 'suppressed';

/** Feature numbers for one closed life. Absent keys were not observed. */
export type WatchLifeFeatures = Partial<Record<WatchFeature, number>>;

/** Welford aggregate. `m2` is the sum of squared deviations, not a variance. */
export interface PopulationMoments {
  n: number;
  mean: number;
  m2: number;
}

export type SelfMoments = Partial<Record<WatchFeature, PopulationMoments>>;

export interface WatchProfile {
  serverAlias: string;
  profileKey: string;
  kind: WatchIdentityKind;
  displayName: string | null;
  lastGuid: string | null;
  lastIp: string | null;
  lifeCount: number;
  selfMoments: SelfMoments;
  lastSeenAt: Date;
}

export interface RecordLifeInput {
  serverAlias: string;
  profileKey: string;
  kind: WatchIdentityKind;
  displayName?: string | null;
  lastGuid?: string | null;
  lastIp?: string | null;
  mapName: string | null;
  endReason: WatchEndReason;
  startedAt: Date;
  endedAt: Date;
  features: WatchLifeFeatures;
  lifeScore: number | null;
  featuresOverFlag: number;
  aimAgreeing: number;
  excludedFromPopulation: boolean;
}

export interface UpsertProfileNameInput {
  serverAlias: string;
  profileKey: string;
  /** Color codes are already stripped by the caller. */
  strippedName: string;
  seenAt: Date;
}

export interface PopulationQuery {
  serverAlias: string;
  mapName: string;
  feature: WatchFeature;
  now: Date;
}

export interface RecordEvidenceInput {
  serverAlias: string;
  profileKey: string;
  action: WatchEvidenceAction;
  reason?: string | null;
  createdAt: Date;
  lifeScore: number;
  features: WatchLifeFeatures;
  trace?: unknown;
  reportId?: number | null;
}

export interface WatchStore {
  recordLife(input: RecordLifeInput): Promise<void>;
  upsertProfileName(input: UpsertProfileNameInput): Promise<void>;
  /** Rows with `last_seen_at` in the last 24 hours. Older rows stay stored and do not count. */
  distinctNames24h(
    serverAlias: string,
    profileKey: string,
    now: Date,
  ): Promise<number>;
  getProfile(
    serverAlias: string,
    profileKey: string,
  ): Promise<WatchProfile | undefined>;
  /** Merged `watch_population_days` for the last 14 UTC days, weapon class `all`. */
  populationMoments(query: PopulationQuery): Promise<PopulationMoments>;
  /** Population z for `value`. Undefined when the merged window cannot form one. */
  populationZ(
    query: PopulationQuery & { value: number },
  ): Promise<number | undefined>;
  recordEvidence(input: RecordEvidenceInput): Promise<void>;
  pruneWatchRetention(now: Date): Promise<void>;
  close(): Promise<void>;
}
