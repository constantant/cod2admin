/** One observation of one entity at one server time. Angles are degrees. Identity is not on a sample. */
export interface Sample {
  /** Server time from the snapshot, milliseconds. Not Date.now(). */
  serverTimeMs: number;
  receivedAtMs: number;
  serverAlias: string;
  /** Client slot whose life this observation belongs to. */
  slot: number;
  entityNum: number;
  origin?: { x: number; y: number; z: number };
  velocity?: { x: number; y: number; z: number };
  /** View angles for this entity. Missing when the protocol did not send them. */
  viewangles?: { pitch: number; yaw: number };
  weapon?: number;
  /** Buttons bitfield, when the message exposed one. */
  buttons?: number;
  event?: 'spawn' | 'death' | 'kill' | 'hit';
  /** Other entity involved in `event`, when the protocol names one. */
  otherEntityNum?: number;
}

export type LifeEnd = 'death' | 'disconnect' | 'map';

/** Raw feature numbers for one closed life. Absent when the inputs were not there. No z-score. */
export interface LifeFeatures {
  slot: number;
  endReason: LifeEnd;
  /** Map the tracker was constructed with. Null never enters a population bucket. */
  mapName: string | null;
  /** View-direction change, in degrees, onto an enemy's first appearance. */
  snapOnAcquire?: number;
  /** View error, in degrees, at a hit or kill. Set only when that error is above 30. */
  firedWhileLookingAway?: number;
  /** View error, in degrees, at the hit or kill. Stored only. */
  viewErrorAtHit?: number;
  /** Server time from that enemy's first appearance to the hit or kill. Stored only. */
  timeToDamageMs?: number;
  /** 95th percentile of yaw rate, degrees per second, while an enemy is in the snapshot. Stored only. */
  angularSpeedP95?: number;
  /** Max horizontal speed / gSpeed on a run above 1.5× gSpeed for more than one second. */
  speedOverG?: number;
}

export interface WatchThresholds {
  flagZ: number;
  kickZ: number;
  minFeatureN: number;
  minSelfLives: number;
  kickExtremeLives: number;
  kickMinSessionLives: number;
  maxKicksPerHour: number;
  maxCardsPerHour: number;
}

export const DEFAULT_WATCH_THRESHOLDS: WatchThresholds = {
  flagZ: 4,
  kickZ: 6,
  minFeatureN: 5000,
  minSelfLives: 8,
  kickExtremeLives: 3,
  kickMinSessionLives: 3,
  maxKicksPerHour: 2,
  maxCardsPerHour: 10,
};

/** Merged population window for one feature. `m2` is the Welford second moment. */
export interface PopulationMoments {
  n: number;
  mean: number;
  m2: number;
}

export interface ScoreLifeInput {
  confirmedAimFeatures: 0 | 1 | 2;
  thresholds: WatchThresholds;
  /** Omitted moments are not scored. */
  snapOnAcquire?: PopulationMoments;
  firedWhileLookingAway?: PopulationMoments;
  speedOverG?: PopulationMoments;
}

export interface LifeScore {
  /** Max population z of scored features, or 0. Not z plus a count. */
  lifeScore: number;
  /** How many scored z values are at least `flagZ`. Speed can make this 1. */
  featuresOverFlag: number;
  /** How many confirmed aim features have z at least `kickZ`. Speed is not in this count. */
  aimAgreeing: number;
  /** True when `lifeScore >= flagZ` or the life has no map name. */
  excludedFromPopulation: boolean;
  mapName: string | null;
}

export interface PolicyInput {
  /** `off` is accepted so a forwarded settings mode cannot fall through to kick. */
  mode: 'off' | 'flag' | 'report' | 'kick';
  endReason: LifeEnd;
  lifeScore: number;
  featuresOverFlag: number;
  aimAgreeing: number;
  livesThisSession: number;
  extremeLivesInLast5: number;
  /** Non-excluded lives with that aim feature present. */
  selfLivesByFeature: { snapOnAcquire: number; firedWhileLookingAway: number };
  /** Self z when selfLives is at least `minSelfLives`. Absent otherwise. */
  selfZByFeature: { snapOnAcquire?: number; firedWhileLookingAway?: number };
  /** Population window n for the map key, per aim feature. */
  featureN: { snapOnAcquire: number; firedWhileLookingAway: number };
  identityKind: 'hwid' | 'guid' | 'ip';
  /** Already counted by the caller. This package does not store names. */
  distinctNames24h: number;
  confirmedAimFeatures: 0 | 1 | 2;
  kickedThisHour: number;
  cardsThisHour: number;
  cooldownActive: boolean;
  mapName: string | null;
  thresholds: WatchThresholds;
}

export type PolicyAction = 'none' | 'flag' | 'report' | 'kick';
