import type {
  LifeFeatures,
  LifeScore,
  PolicyAction,
  PolicyInput,
  PopulationMoments,
  ScoreLifeInput,
} from './types.js';

/**
 * Population z for the features this call is allowed to score.
 * `confirmedAimFeatures` 0 scores neither aim feature, 1 scores only snap, 2 scores both.
 * Speed is scored whenever it is present. It never counts as aim.
 */
export function scoreLife(
  features: LifeFeatures,
  input: ScoreLifeInput,
): LifeScore {
  const { thresholds } = input;
  let lifeScore = 0;
  let featuresOverFlag = 0;
  let aimAgreeing = 0;

  const consider = (z: number | undefined, countsAsAim: boolean): void => {
    if (z === undefined) return;
    // A negative z is real but it is not the cheat direction, so it does not raise the score.
    if (z > 0 && z > lifeScore) lifeScore = z;
    if (z >= thresholds.flagZ) featuresOverFlag += 1;
    if (countsAsAim && z >= thresholds.kickZ) aimAgreeing += 1;
  };

  consider(populationZ(features.speedOverG, input.speedOverG), false);
  if (input.confirmedAimFeatures >= 1) {
    consider(populationZ(features.snapOnAcquire, input.snapOnAcquire), true);
  }
  if (input.confirmedAimFeatures >= 2) {
    consider(
      populationZ(features.firedWhileLookingAway, input.firedWhileLookingAway),
      true,
    );
  }

  return {
    lifeScore,
    featuresOverFlag,
    aimAgreeing,
    excludedFromPopulation:
      lifeScore >= thresholds.flagZ || features.mapName === null,
    mapName: features.mapName,
  };
}

/** First matching rule wins. Anything other than `flag`, `report`, or `kick` returns `none`. */
export function decide(input: PolicyInput): PolicyAction {
  if (input.mode !== 'flag' && input.mode !== 'report' && input.mode !== 'kick')
    return 'none';
  const { thresholds } = input;
  if (
    !Number.isFinite(thresholds.flagZ) ||
    !Number.isFinite(thresholds.kickZ) ||
    !Number.isFinite(thresholds.minFeatureN) ||
    !Number.isFinite(thresholds.minSelfLives) ||
    !Number.isFinite(thresholds.kickExtremeLives) ||
    !Number.isFinite(thresholds.kickMinSessionLives) ||
    !Number.isFinite(thresholds.maxKicksPerHour) ||
    !Number.isFinite(thresholds.maxCardsPerHour)
  ) {
    return 'none';
  }
  if (!(input.lifeScore >= thresholds.flagZ) || !(input.featuresOverFlag >= 1))
    return 'none';
  if (!(input.cardsThisHour < thresholds.maxCardsPerHour)) return 'none';
  if (input.cooldownActive) return 'none';

  const downgraded = input.mode === 'flag' ? 'flag' : 'report';
  if (
    input.endReason === 'disconnect' ||
    input.endReason === 'map' ||
    input.mapName === null
  ) {
    return downgraded;
  }
  // Zero names and two names both mean this IP is not one person. One name passes.
  if (input.identityKind === 'ip' && input.distinctNames24h !== 1)
    return downgraded;

  if (input.mode === 'flag') return 'flag';
  if (input.mode === 'report') return 'report';
  return kickAllowed(input) ? 'kick' : 'report';
}

function kickAllowed(input: PolicyInput): boolean {
  const { thresholds } = input;
  if (input.endReason !== 'death') return false;
  if (input.confirmedAimFeatures !== 2) return false;
  if (input.aimAgreeing !== 2) return false;
  if (!(input.featureN.snapOnAcquire >= thresholds.minFeatureN)) return false;
  if (!(input.featureN.firedWhileLookingAway >= thresholds.minFeatureN))
    return false;
  if (!(input.selfLivesByFeature.snapOnAcquire >= thresholds.minSelfLives))
    return false;
  if (
    !(input.selfLivesByFeature.firedWhileLookingAway >= thresholds.minSelfLives)
  )
    return false;
  const snapZ = input.selfZByFeature.snapOnAcquire;
  const awayZ = input.selfZByFeature.firedWhileLookingAway;
  if (!(snapZ !== undefined && snapZ >= thresholds.kickZ)) return false;
  if (!(awayZ !== undefined && awayZ >= thresholds.kickZ)) return false;
  if (!(input.extremeLivesInLast5 >= thresholds.kickExtremeLives)) return false;
  if (!(input.livesThisSession >= thresholds.kickMinSessionLives)) return false;
  if (!(input.kickedThisHour < thresholds.maxKicksPerHour)) return false;
  return true;
}

/** Sample standard deviation from the Welford moment: `sd = sqrt(m2 / (n - 1))`. */
function populationZ(
  value: number | undefined,
  moments: PopulationMoments | undefined,
): number | undefined {
  if (value === undefined || moments === undefined) return undefined;
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(moments.n) ||
    !Number.isFinite(moments.mean) ||
    !Number.isFinite(moments.m2)
  ) {
    return undefined;
  }
  if (moments.n < 30 || moments.m2 <= 0) return undefined;
  const sd = Math.sqrt(moments.m2 / (moments.n - 1));
  if (!Number.isFinite(sd) || sd === 0) return undefined;
  return (value - moments.mean) / sd;
}
