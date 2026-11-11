import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WATCH_THRESHOLDS,
  LifeTracker,
  decide,
  scoreLife,
  type LifeFeatures,
  type PolicyInput,
  type PopulationMoments,
  type Sample,
  type WatchThresholds,
} from '../index.js';

function sample(
  overrides: Partial<Sample> & Pick<Sample, 'serverTimeMs'>,
): Sample {
  return {
    receivedAtMs: overrides.serverTimeMs,
    serverAlias: 'dev',
    slot: 1,
    entityNum: 1,
    ...overrides,
  };
}

/** Population moments whose z at `value` is `z` when mean is 0 and n is 30. */
function momentsForZ(value: number, z: number, n = 30): PopulationMoments {
  const sd = value / z;
  return { n, mean: 0, m2: sd * sd * (n - 1) };
}

function close(tracker: LifeTracker, slot = 1): LifeFeatures {
  const life = tracker.end(slot, 'death');
  if (!life) throw new Error(`expected an open life for slot ${slot}`);
  return life;
}

/** Four steady samples, then a snap onto +X and a kill facing -X. */
function cheatLife(mapName: string | null = 'mp_toujane'): LifeFeatures {
  const tracker = new LifeTracker(mapName, null);
  for (const serverTimeMs of [500, 600, 700, 800]) {
    tracker.push(
      sample({
        serverTimeMs,
        origin: { x: 0, y: 0, z: 0 },
        viewangles: { pitch: 0, yaw: 90 },
      }),
    );
  }
  tracker.push(
    sample({
      serverTimeMs: 1000,
      entityNum: 2,
      origin: { x: 100, y: 0, z: 0 },
    }),
  );
  tracker.push(
    sample({
      serverTimeMs: 1000,
      origin: { x: 0, y: 0, z: 0 },
      viewangles: { pitch: 0, yaw: 0 },
    }),
  );
  tracker.push(
    sample({
      serverTimeMs: 1500,
      entityNum: 2,
      origin: { x: 100, y: 0, z: 0 },
    }),
  );
  tracker.push(
    sample({
      serverTimeMs: 1500,
      origin: { x: 0, y: 0, z: 0 },
      viewangles: { pitch: 0, yaw: 180 },
      event: 'kill',
      otherEntityNum: 2,
    }),
  );
  return close(tracker);
}

function calmLife(): LifeFeatures {
  const tracker = new LifeTracker('mp_toujane', 190);
  for (const serverTimeMs of [0, 100, 200, 300, 400]) {
    tracker.push(
      sample({
        serverTimeMs,
        origin: { x: 0, y: 0, z: 0 },
        viewangles: { pitch: 0, yaw: 0 },
        velocity: { x: 100, y: 0, z: 0 },
      }),
    );
  }
  tracker.push(
    sample({ serverTimeMs: 500, entityNum: 2, origin: { x: 200, y: 0, z: 0 } }),
  );
  tracker.push(
    sample({
      serverTimeMs: 500,
      origin: { x: 0, y: 0, z: 0 },
      viewangles: { pitch: 0, yaw: 0 },
      velocity: { x: 100, y: 0, z: 0 },
      event: 'kill',
      otherEntityNum: 2,
    }),
  );
  tracker.push(sample({ serverTimeMs: 600, event: 'death' }));
  return close(tracker);
}

function speedLife(
  gSpeed: number | null,
  times: number[],
  vx: number,
): LifeFeatures {
  const tracker = new LifeTracker('mp_toujane', gSpeed);
  for (const serverTimeMs of times) {
    tracker.push(sample({ serverTimeMs, velocity: { x: vx, y: 0, z: 0 } }));
  }
  return close(tracker);
}

/** Timestamps from 0 through `spanMs`, stepping by `step`. */
function speedTimes(spanMs: number, step = 50): number[] {
  const times: number[] = [];
  for (let t = 0; t <= spanMs; t += step) times.push(t);
  if (times[times.length - 1] !== spanMs) times.push(spanMs);
  return times;
}

function viewErrorLife(
  yaw: number,
  pitch: number,
  enemy: { x: number; y: number; z: number },
): LifeFeatures {
  const tracker = new LifeTracker('mp_toujane', null);
  tracker.push(sample({ serverTimeMs: 0, entityNum: 2, origin: enemy }));
  tracker.push(
    sample({
      serverTimeMs: 0,
      origin: { x: 0, y: 0, z: 0 },
      viewangles: { pitch, yaw },
      event: 'hit',
      otherEntityNum: 2,
    }),
  );
  return close(tracker);
}

function kickInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    mode: 'kick',
    endReason: 'death',
    lifeScore: 8,
    featuresOverFlag: 2,
    aimAgreeing: 2,
    livesThisSession: 3,
    extremeLivesInLast5: 3,
    selfLivesByFeature: { snapOnAcquire: 8, firedWhileLookingAway: 8 },
    selfZByFeature: { snapOnAcquire: 6, firedWhileLookingAway: 6 },
    featureN: { snapOnAcquire: 5000, firedWhileLookingAway: 5000 },
    identityKind: 'guid',
    distinctNames24h: 1,
    confirmedAimFeatures: 2,
    kickedThisHour: 0,
    cardsThisHour: 0,
    cooldownActive: false,
    mapName: 'mp_toujane',
    thresholds: DEFAULT_WATCH_THRESHOLDS,
    ...overrides,
  };
}

function scoreAim(life: LifeFeatures, confirmedAimFeatures: 0 | 1 | 2) {
  return scoreLife(life, {
    confirmedAimFeatures,
    thresholds: DEFAULT_WATCH_THRESHOLDS,
    snapOnAcquire: momentsForZ(life.snapOnAcquire ?? 1, 8),
    firedWhileLookingAway: momentsForZ(life.firedWhileLookingAway ?? 1, 8),
  });
}

describe('LifeTracker', () => {
  it('measures a snap onto +X and a kill while facing the other way', () => {
    const life = cheatLife();

    expect(life.endReason).toBe('death');
    expect(life.mapName).toBe('mp_toujane');
    expect(life.snapOnAcquire).toBeCloseTo(90, 5);
    expect(life.firedWhileLookingAway).toBeCloseTo(180, 5);
    expect(life.viewErrorAtHit).toBeCloseTo(180, 5);
    expect(life.timeToDamageMs).toBe(500);
    expect(life.angularSpeedP95).toBeCloseTo(450, 4);
    expect(life.speedOverG).toBeUndefined();
  });

  it('keeps a calm trace near zero view error and does not call that looking away', () => {
    const life = calmLife();

    expect(life.snapOnAcquire).toBeCloseTo(0, 5);
    expect(life.viewErrorAtHit).toBeCloseTo(0, 5);
    expect(life.firedWhileLookingAway).toBeUndefined();
    expect(life.speedOverG).toBeUndefined();
    expect(life.angularSpeedP95).toBe(0);
  });

  it('view error is about 0 on +X, about 90 on +Y, and pitch 90 faces down', () => {
    const onX = viewErrorLife(0, 0, { x: 100, y: 0, z: 0 });
    expect(onX.viewErrorAtHit).toBeCloseTo(0, 5);
    expect(onX.firedWhileLookingAway).toBeUndefined();

    const onY = viewErrorLife(0, 0, { x: 0, y: 100, z: 0 });
    expect(onY.viewErrorAtHit).toBeCloseTo(90, 5);
    expect(onY.firedWhileLookingAway).toBeCloseTo(90, 5);

    const down = viewErrorLife(0, 90, { x: 0, y: 0, z: -100 });
    expect(down.viewErrorAtHit).toBeCloseTo(0, 5);
  });

  it('does not snap without four angle samples in the 500 ms before the enemy appears', () => {
    const tracker = new LifeTracker('mp_toujane', null);
    for (const serverTimeMs of [700, 800, 900]) {
      tracker.push(
        sample({
          serverTimeMs,
          origin: { x: 0, y: 0, z: 0 },
          viewangles: { pitch: 0, yaw: 90 },
        }),
      );
    }
    tracker.push(
      sample({
        serverTimeMs: 1000,
        entityNum: 2,
        origin: { x: 100, y: 0, z: 0 },
      }),
    );
    tracker.push(
      sample({
        serverTimeMs: 1000,
        origin: { x: 0, y: 0, z: 0 },
        viewangles: { pitch: 0, yaw: 0 },
      }),
    );

    expect(close(tracker).snapOnAcquire).toBeUndefined();
  });

  it('yields no snap when viewangles are missing and does not throw', () => {
    const tracker = new LifeTracker('mp_toujane', null);

    expect(() => {
      for (const serverTimeMs of [500, 600, 700, 800, 1000]) {
        tracker.push(sample({ serverTimeMs, origin: { x: 0, y: 0, z: 0 } }));
      }
      tracker.push(
        sample({
          serverTimeMs: 1000,
          entityNum: 2,
          origin: { x: 100, y: 0, z: 0 },
        }),
      );
      tracker.push(
        sample({
          serverTimeMs: 1000,
          origin: { x: 0, y: 0, z: 0 },
          event: 'kill',
          otherEntityNum: 2,
        }),
      );
    }).not.toThrow();

    const life = close(tracker);
    expect(life.snapOnAcquire).toBeUndefined();
    expect(life.firedWhileLookingAway).toBeUndefined();
  });

  it('closes the slot once on its own death and not when another entity dies', () => {
    const tracker = new LifeTracker('mp_toujane', null);
    tracker.push(sample({ serverTimeMs: 0, viewangles: { pitch: 0, yaw: 0 } }));
    expect(
      tracker.push(
        sample({
          serverTimeMs: 10,
          entityNum: 2,
          event: 'death',
          origin: { x: 1, y: 0, z: 0 },
        }),
      ),
    ).toBeNull();

    tracker.push(sample({ slot: 2, entityNum: 2, serverTimeMs: 0 }));
    expect(
      tracker.push(
        sample({ slot: 2, entityNum: 2, serverTimeMs: 10, event: 'death' }),
      ),
    ).toBeNull();
    const other = tracker.end(2, 'disconnect');
    expect(other?.slot).toBe(2);
    expect(other?.endReason).toBe('death');
    expect(tracker.end(2, 'disconnect')).toBeNull();

    const life = tracker.end(1, 'map');
    expect(life?.endReason).toBe('map');
    expect(life?.mapName).toBe('mp_toujane');
    expect(tracker.end(1, 'disconnect')).toBeNull();
    expect(tracker.end(9, 'disconnect')).toBeNull();
  });

  it('records speedOverG only for a run above 1.5× the given gSpeed lasting more than a second', () => {
    expect(speedLife(100, speedTimes(1001), 160).speedOverG).toBeCloseTo(
      1.6,
      5,
    );
    expect(speedLife(100, speedTimes(1000), 160).speedOverG).toBeUndefined();
    expect(speedLife(100, speedTimes(1001), 150).speedOverG).toBeUndefined();
    expect(speedLife(null, speedTimes(1001), 500).speedOverG).toBeUndefined();
    expect(speedLife(0, speedTimes(1001), 500).speedOverG).toBeUndefined();
    expect(speedLife(100, speedTimes(2000, 100), 160).speedOverG).toBeCloseTo(
      1.6,
      5,
    );

    const broken = new LifeTracker('mp_toujane', 100);
    for (const serverTimeMs of speedTimes(600)) {
      broken.push(sample({ serverTimeMs, velocity: { x: 200, y: 0, z: 0 } }));
    }
    broken.push(
      sample({ serverTimeMs: 650, velocity: { x: 100, y: 0, z: 0 } }),
    );
    for (let serverTimeMs = 700; serverTimeMs <= 1100; serverTimeMs += 50) {
      broken.push(sample({ serverTimeMs, velocity: { x: 200, y: 0, z: 0 } }));
    }
    expect(close(broken).speedOverG).toBeUndefined();
  });

  it('acquires from the first origin, not from an earlier hit that only named the entity', () => {
    const tracker = new LifeTracker('mp_toujane', null);
    for (const serverTimeMs of [500, 600, 700, 800]) {
      tracker.push(
        sample({
          serverTimeMs,
          origin: { x: 0, y: 0, z: 0 },
          viewangles: { pitch: 0, yaw: 90 },
        }),
      );
    }
    tracker.push(
      sample({
        serverTimeMs: 900,
        origin: { x: 0, y: 0, z: 0 },
        viewangles: { pitch: 0, yaw: 90 },
        event: 'hit',
        otherEntityNum: 2,
      }),
    );
    tracker.push(
      sample({
        serverTimeMs: 1000,
        entityNum: 2,
        origin: { x: 100, y: 0, z: 0 },
      }),
    );
    tracker.push(
      sample({
        serverTimeMs: 1000,
        origin: { x: 0, y: 0, z: 0 },
        viewangles: { pitch: 0, yaw: 0 },
      }),
    );
    tracker.push(
      sample({
        serverTimeMs: 1500,
        entityNum: 2,
        origin: { x: 100, y: 0, z: 0 },
      }),
    );
    tracker.push(
      sample({
        serverTimeMs: 1500,
        origin: { x: 0, y: 0, z: 0 },
        viewangles: { pitch: 0, yaw: 180 },
        event: 'kill',
        otherEntityNum: 2,
      }),
    );

    const life = close(tracker);
    expect(life.snapOnAcquire).toBeCloseTo(90, 5);
    expect(life.timeToDamageMs).toBe(500);

    const reversed = new LifeTracker('mp_toujane', null);
    for (const serverTimeMs of [500, 600, 700, 800]) {
      reversed.push(
        sample({
          serverTimeMs,
          origin: { x: 0, y: 0, z: 0 },
          viewangles: { pitch: 0, yaw: 90 },
        }),
      );
    }
    reversed.push(
      sample({
        serverTimeMs: 1000,
        entityNum: 2,
        origin: { x: 100, y: 0, z: 0 },
      }),
    );
    reversed.push(
      sample({
        serverTimeMs: 1000,
        origin: { x: 0, y: 0, z: 0 },
        viewangles: { pitch: 0, yaw: 0 },
      }),
    );
    reversed.push(
      sample({
        serverTimeMs: 900,
        event: 'hit',
        otherEntityNum: 2,
      }),
    );
    expect(close(reversed).snapOnAcquire).toBeCloseTo(90, 5);
  });

  it('keeps same-tick samples that arrive after the death on that life', () => {
    const tracker = new LifeTracker('mp_toujane', null);
    for (const serverTimeMs of [500, 600, 700, 800]) {
      tracker.push(
        sample({
          serverTimeMs,
          origin: { x: 0, y: 0, z: 0 },
          viewangles: { pitch: 0, yaw: 90 },
        }),
      );
    }
    expect(
      tracker.push(
        sample({
          serverTimeMs: 1000,
          origin: { x: 0, y: 0, z: 0 },
          viewangles: { pitch: 0, yaw: 180 },
          event: 'death',
        }),
      ),
    ).toBeNull();
    expect(
      tracker.push(
        sample({
          serverTimeMs: 1000,
          entityNum: 2,
          origin: { x: 100, y: 0, z: 0 },
        }),
      ),
    ).toBeNull();

    const closed = tracker.push(
      sample({
        serverTimeMs: 1100,
        origin: { x: 1, y: 0, z: 0 },
        viewangles: { pitch: 0, yaw: 0 },
      }),
    );
    expect(closed?.endReason).toBe('death');
    expect(closed?.snapOnAcquire).toBeCloseTo(90, 5);

    const next = tracker.end(1, 'map');
    expect(next?.endReason).toBe('map');
    expect(next?.snapOnAcquire).toBeUndefined();
  });

  it('ignores a non-finite hit angle and still records a later finite one', () => {
    const tracker = new LifeTracker('mp_toujane', null);
    tracker.push(
      sample({
        serverTimeMs: 0,
        entityNum: 2,
        origin: { x: -100, y: 0, z: 0 },
      }),
    );
    tracker.push(
      sample({
        serverTimeMs: 0,
        origin: { x: 0, y: 0, z: 0 },
        viewangles: { pitch: Number.NaN, yaw: 0 },
        event: 'hit',
        otherEntityNum: 2,
      }),
    );
    tracker.push(
      sample({
        serverTimeMs: 100,
        entityNum: 2,
        origin: { x: -100, y: 0, z: 0 },
      }),
    );
    tracker.push(
      sample({
        serverTimeMs: 100,
        origin: { x: 0, y: 0, z: 0 },
        viewangles: { pitch: 0, yaw: 0 },
        event: 'kill',
        otherEntityNum: 2,
      }),
    );

    const life = close(tracker);
    expect(life.viewErrorAtHit).toBeCloseTo(180, 5);
    expect(life.firedWhileLookingAway).toBeCloseTo(180, 5);
  });

  it('does not join a speed run across a missing velocity or a dropped snapshot', () => {
    const missingVelocity = new LifeTracker('mp_toujane', 100);
    missingVelocity.push(
      sample({ serverTimeMs: 0, velocity: { x: 200, y: 0, z: 0 } }),
    );
    missingVelocity.push(
      sample({ serverTimeMs: 500, origin: { x: 0, y: 0, z: 0 } }),
    );
    missingVelocity.push(
      sample({ serverTimeMs: 5000, velocity: { x: 200, y: 0, z: 0 } }),
    );
    expect(close(missingVelocity).speedOverG).toBeUndefined();

    const dropped = new LifeTracker('mp_toujane', 100);
    dropped.push(sample({ serverTimeMs: 0, velocity: { x: 200, y: 0, z: 0 } }));
    dropped.push(
      sample({ serverTimeMs: 5000, velocity: { x: 200, y: 0, z: 0 } }),
    );
    expect(close(dropped).speedOverG).toBeUndefined();

    const jitter = speedTimes(1100);
    const at500 = jitter.indexOf(500);
    jitter[at500] = 502;
    expect(speedLife(100, jitter, 160).speedOverG).toBeCloseTo(1.6, 5);

    const droppedSnap = new LifeTracker('mp_toujane', 100);
    for (const serverTimeMs of speedTimes(600)) {
      droppedSnap.push(
        sample({ serverTimeMs, velocity: { x: 160, y: 0, z: 0 } }),
      );
    }
    for (let serverTimeMs = 750; serverTimeMs <= 1200; serverTimeMs += 50) {
      droppedSnap.push(
        sample({ serverTimeMs, velocity: { x: 160, y: 0, z: 0 } }),
      );
    }
    expect(close(droppedSnap).speedOverG).toBeUndefined();

    const sameTickHole = new LifeTracker('mp_toujane', 100);
    for (const serverTimeMs of speedTimes(1100)) {
      sameTickHole.push(
        sample({ serverTimeMs, velocity: { x: 200, y: 0, z: 0 } }),
      );
      if (serverTimeMs === 500) {
        sameTickHole.push(
          sample({ serverTimeMs, origin: { x: 1, y: 0, z: 0 } }),
        );
      }
    }
    expect(close(sameTickHole).speedOverG).toBeUndefined();
  });

  it('returns a null map name when the tracker was not given one', () => {
    const tracker = new LifeTracker(null, null);
    tracker.push(sample({ serverTimeMs: 0 }));
    expect(close(tracker).mapName).toBeNull();
  });
});

describe('scoreLife', () => {
  it('flags a snap plus a looking-away kill only when those aim features are confirmed', () => {
    const life = cheatLife();
    const scored = scoreAim(life, 2);

    expect(scored.lifeScore).toBeCloseTo(8, 5);
    expect(scored.featuresOverFlag).toBe(2);
    expect(scored.aimAgreeing).toBe(2);
    expect(scored.mapName).toBe('mp_toujane');
    expect(scored.excludedFromPopulation).toBe(true);
    expect(
      decide(
        kickInput({
          mode: 'flag',
          lifeScore: scored.lifeScore,
          featuresOverFlag: scored.featuresOverFlag,
          aimAgreeing: scored.aimAgreeing,
          mapName: scored.mapName,
          endReason: life.endReason,
        }),
      ),
    ).toBe('flag');

    const snapOnly = scoreAim(life, 1);
    expect(snapOnly.lifeScore).toBeCloseTo(8, 5);
    expect(snapOnly.featuresOverFlag).toBe(1);
    expect(snapOnly.aimAgreeing).toBe(1);

    const unconfirmed = scoreAim(life, 0);
    expect(unconfirmed.lifeScore).toBe(0);
    expect(unconfirmed.aimAgreeing).toBe(0);
    expect(unconfirmed.featuresOverFlag).toBe(0);
    expect(unconfirmed.lifeScore).toBeLessThan(scored.lifeScore);
  });

  it('does not flag a calm human trace', () => {
    const life = calmLife();
    const scored = scoreLife(life, {
      confirmedAimFeatures: 2,
      thresholds: DEFAULT_WATCH_THRESHOLDS,
      snapOnAcquire: { n: 30, mean: 0, m2: 29 },
    });

    expect(scored.lifeScore).toBeLessThan(DEFAULT_WATCH_THRESHOLDS.flagZ);
    expect(scored.featuresOverFlag).toBe(0);
    expect(scored.aimAgreeing).toBe(0);
    expect(scored.excludedFromPopulation).toBe(false);
    expect(
      decide(
        kickInput({
          mode: 'flag',
          lifeScore: scored.lifeScore,
          featuresOverFlag: scored.featuresOverFlag,
          aimAgreeing: scored.aimAgreeing,
          mapName: scored.mapName,
        }),
      ),
    ).toBe('none');
  });

  it('keeps lifeScore as the max z, so a z of 4 does not cross kickZ 6', () => {
    const features: LifeFeatures = {
      slot: 1,
      endReason: 'death',
      mapName: 'mp_breakout',
      snapOnAcquire: 40,
      firedWhileLookingAway: 40,
    };
    const moments = momentsForZ(40, 4);
    const scored = scoreLife(features, {
      confirmedAimFeatures: 2,
      thresholds: DEFAULT_WATCH_THRESHOLDS,
      snapOnAcquire: moments,
      firedWhileLookingAway: moments,
    });

    expect(scored.lifeScore).toBe(4);
    expect(scored.lifeScore).toBeLessThan(DEFAULT_WATCH_THRESHOLDS.kickZ);
    expect(scored.featuresOverFlag).toBe(2);
    expect(scored.aimAgreeing).toBe(0);
    expect(scored.excludedFromPopulation).toBe(true);
    expect(
      decide(
        kickInput({
          lifeScore: scored.lifeScore,
          featuresOverFlag: scored.featuresOverFlag,
          aimAgreeing: scored.aimAgreeing,
        }),
      ),
    ).toBe('report');
  });

  it('does not let speed count as aim, including when it is the only high z', () => {
    const life = speedLife(100, speedTimes(1100), 200);
    expect(life.speedOverG).toBeCloseTo(2, 5);

    const onlySpeed = scoreLife(life, {
      confirmedAimFeatures: 2,
      thresholds: DEFAULT_WATCH_THRESHOLDS,
      speedOverG: momentsForZ(life.speedOverG ?? 1, 10),
      snapOnAcquire: momentsForZ(90, 10),
      firedWhileLookingAway: momentsForZ(90, 10),
    });
    expect(onlySpeed.lifeScore).toBeCloseTo(10, 5);
    expect(onlySpeed.featuresOverFlag).toBe(1);
    expect(onlySpeed.aimAgreeing).toBe(0);
    expect(
      decide(
        kickInput({
          lifeScore: onlySpeed.lifeScore,
          featuresOverFlag: onlySpeed.featuresOverFlag,
          aimAgreeing: onlySpeed.aimAgreeing,
        }),
      ),
    ).not.toBe('kick');

    const stillScoredAtZero = scoreLife(life, {
      confirmedAimFeatures: 0,
      thresholds: DEFAULT_WATCH_THRESHOLDS,
      speedOverG: momentsForZ(life.speedOverG ?? 1, 10),
    });
    expect(stillScoredAtZero.lifeScore).toBeCloseTo(10, 5);
    expect(stillScoredAtZero.aimAgreeing).toBe(0);

    const withOneAim = scoreLife(
      { ...life, snapOnAcquire: 90 },
      {
        confirmedAimFeatures: 2,
        thresholds: DEFAULT_WATCH_THRESHOLDS,
        snapOnAcquire: momentsForZ(90, 8),
        speedOverG: momentsForZ(life.speedOverG ?? 1, 8),
      },
    );
    expect(withOneAim.aimAgreeing).toBe(1);
    expect(withOneAim.featuresOverFlag).toBe(2);
  });

  it('stores a raw feature below n 30 or with no spread and does not score it', () => {
    const life = speedLife(100, speedTimes(1100), 200);
    const belowN = scoreLife(life, {
      confirmedAimFeatures: 2,
      thresholds: DEFAULT_WATCH_THRESHOLDS,
      speedOverG: { n: 29, mean: 0, m2: 1000 },
    });
    expect(life.speedOverG).toBeCloseTo(2, 5);
    expect(belowN.lifeScore).toBe(0);
    expect(belowN.featuresOverFlag).toBe(0);

    const flat = scoreLife(life, {
      confirmedAimFeatures: 2,
      thresholds: DEFAULT_WATCH_THRESHOLDS,
      speedOverG: { n: 100, mean: 2, m2: 0 },
    });
    expect(flat.lifeScore).toBe(0);

    const negative = scoreLife(life, {
      confirmedAimFeatures: 2,
      thresholds: DEFAULT_WATCH_THRESHOLDS,
      speedOverG: { n: 30, mean: 10, m2: 29 },
    });
    expect(negative.lifeScore).toBe(0);
    expect(negative.featuresOverFlag).toBe(0);
  });

  it('excludes a null map even when nothing scored, and reads flagZ from the argument', () => {
    const tracker = new LifeTracker(null, null);
    tracker.push(sample({ serverTimeMs: 0 }));
    const life = close(tracker);
    const scored = scoreLife(life, {
      confirmedAimFeatures: 0,
      thresholds: DEFAULT_WATCH_THRESHOLDS,
    });

    expect(life.mapName).toBeNull();
    expect(scored.mapName).toBeNull();
    expect(scored.lifeScore).toBe(0);
    expect(scored.excludedFromPopulation).toBe(true);

    const highThresholds: WatchThresholds = {
      ...DEFAULT_WATCH_THRESHOLDS,
      flagZ: 10,
    };
    const under = scoreLife(
      { slot: 1, endReason: 'death', mapName: 'mp_toujane', speedOverG: 2 },
      {
        confirmedAimFeatures: 0,
        thresholds: highThresholds,
        speedOverG: momentsForZ(2, 6),
      },
    );
    expect(under.lifeScore).toBeCloseTo(6, 5);
    expect(under.featuresOverFlag).toBe(0);
    expect(under.excludedFromPopulation).toBe(false);
  });
});

describe('decide', () => {
  it('kicks only when every gate passes, and one extreme life does not', () => {
    expect(decide(kickInput())).toBe('kick');
    expect(decide(kickInput({ extremeLivesInLast5: 1 }))).toBe('report');
    expect(decide(kickInput({ extremeLivesInLast5: 3 }))).toBe('kick');
    expect(decide(kickInput({ livesThisSession: 2 }))).toBe('report');
  });

  it('downgrades selfLives below 8 to report, and flag mode stays flag', () => {
    const short = { snapOnAcquire: 7, firedWhileLookingAway: 8 };
    expect(
      decide(kickInput({ selfLivesByFeature: short, selfZByFeature: {} })),
    ).toBe('report');
    expect(
      decide(
        kickInput({
          mode: 'flag',
          selfLivesByFeature: short,
          selfZByFeature: {},
        }),
      ),
    ).toBe('flag');
    expect(
      decide(
        kickInput({
          selfLivesByFeature: { snapOnAcquire: 8, firedWhileLookingAway: 8 },
          selfZByFeature: { snapOnAcquire: 6 },
        }),
      ),
    ).toBe('report');
  });

  it('downgrades featureN below 5000 even when the profile life count is large', () => {
    expect(
      decide(
        kickInput({
          featureN: { snapOnAcquire: 4999, firedWhileLookingAway: 9000 },
          selfLivesByFeature: {
            snapOnAcquire: 100,
            firedWhileLookingAway: 100,
          },
        }),
      ),
    ).toBe('report');
  });

  it('returns none for a second flag inside cooldown and for a full card cap', () => {
    expect(decide(kickInput({ mode: 'flag', cooldownActive: true }))).toBe(
      'none',
    );
    expect(decide(kickInput({ cardsThisHour: 10 }))).toBe('none');
    expect(decide(kickInput({ cardsThisHour: 9 }))).toBe('kick');
  });

  it('never kicks a map change, a disconnect, or a missing map', () => {
    expect(decide(kickInput({ endReason: 'map' }))).toBe('report');
    expect(decide(kickInput({ endReason: 'disconnect' }))).toBe('report');
    expect(decide(kickInput({ endReason: 'map', mode: 'flag' }))).toBe('flag');
    expect(decide(kickInput({ mapName: null }))).toBe('report');
    expect(decide(kickInput({ mapName: null, mode: 'flag' }))).toBe('flag');
  });

  it('does not kick an ip key unless distinctNames24h is exactly 1', () => {
    expect(decide(kickInput({ identityKind: 'ip', distinctNames24h: 0 }))).toBe(
      'report',
    );
    expect(decide(kickInput({ identityKind: 'ip', distinctNames24h: 2 }))).toBe(
      'report',
    );
    expect(decide(kickInput({ identityKind: 'ip', distinctNames24h: 1 }))).toBe(
      'kick',
    );
    expect(
      decide(
        kickInput({ identityKind: 'ip', distinctNames24h: 0, mode: 'flag' }),
      ),
    ).toBe('flag');
  });

  it('never returns kick from flag mode, and confirmedAimFeatures below 2 cannot kick', () => {
    expect(decide(kickInput({ mode: 'flag' }))).toBe('flag');
    expect(decide(kickInput({ mode: 'report' }))).toBe('report');
    expect(decide(kickInput({ confirmedAimFeatures: 0 }))).toBe('report');
    expect(decide(kickInput({ confirmedAimFeatures: 1 }))).toBe('report');
  });

  it('does not kick when the hourly kick cap is already spent', () => {
    expect(decide(kickInput({ kickedThisHour: 2 }))).toBe('report');
    expect(decide(kickInput({ kickedThisHour: 1 }))).toBe('kick');
  });

  it('returns none for mode off, a non-finite threshold, or a non-finite kick count', () => {
    expect(decide(kickInput({ mode: 'off' }))).toBe('none');
    expect(decide(kickInput({ mode: 'auto' as PolicyInput['mode'] }))).toBe(
      'none',
    );
    expect(
      decide(
        kickInput({
          thresholds: { ...DEFAULT_WATCH_THRESHOLDS, flagZ: Number.NaN },
        }),
      ),
    ).toBe('none');
    expect(
      decide(
        kickInput({
          mode: 'flag',
          thresholds: {
            ...DEFAULT_WATCH_THRESHOLDS,
            kickZ: null as unknown as number,
          },
        }),
      ),
    ).toBe('none');
    expect(
      decide(
        kickInput({
          thresholds: {
            ...DEFAULT_WATCH_THRESHOLDS,
            minSelfLives: Number.NaN,
          },
          selfLivesByFeature: { snapOnAcquire: 0, firedWhileLookingAway: 0 },
          featureN: { snapOnAcquire: 0, firedWhileLookingAway: 0 },
          extremeLivesInLast5: 0,
          livesThisSession: 0,
          kickedThisHour: 99,
        }),
      ),
    ).toBe('none');
    expect(
      decide(
        kickInput({
          selfZByFeature: {
            snapOnAcquire: Number.NaN,
            firedWhileLookingAway: 6,
          },
        }),
      ),
    ).toBe('report');
    expect(
      decide(
        kickInput({
          featureN: { snapOnAcquire: Number.NaN, firedWhileLookingAway: 5000 },
        }),
      ),
    ).toBe('report');
    expect(decide(kickInput({ kickedThisHour: Number.NaN }))).toBe('report');
    expect(decide(kickInput({ extremeLivesInLast5: Number.NaN }))).toBe(
      'report',
    );
  });

  it('returns none when the score is under flagZ or no feature cleared it', () => {
    expect(decide(kickInput({ lifeScore: 3.9, featuresOverFlag: 2 }))).toBe(
      'none',
    );
    expect(decide(kickInput({ lifeScore: 10, featuresOverFlag: 0 }))).toBe(
      'none',
    );
  });

  it('reads every kick gate from the thresholds argument', () => {
    const thresholds: WatchThresholds = {
      ...DEFAULT_WATCH_THRESHOLDS,
      minSelfLives: 2,
      minFeatureN: 10,
      kickExtremeLives: 1,
      kickMinSessionLives: 1,
      maxKicksPerHour: 1,
      kickZ: 3,
    };
    expect(
      decide(
        kickInput({
          thresholds,
          selfLivesByFeature: { snapOnAcquire: 2, firedWhileLookingAway: 2 },
          selfZByFeature: { snapOnAcquire: 3, firedWhileLookingAway: 3 },
          featureN: { snapOnAcquire: 10, firedWhileLookingAway: 10 },
          extremeLivesInLast5: 1,
          livesThisSession: 1,
          kickedThisHour: 0,
        }),
      ),
    ).toBe('kick');
    expect(decide(kickInput({ thresholds, kickedThisHour: 1 }))).toBe('report');
  });
});
