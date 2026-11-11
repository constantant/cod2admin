import type { LifeEnd, LifeFeatures, Sample } from './types.js';

const ACQUIRE_WINDOW_MS = 500;
const MIN_ANGLES_BEFORE_ACQUIRE = 4;
const LOOKING_AWAY_DEGREES = 30;
const SPEED_OVER_G = 1.5;
const SPEED_RUN_MS = 1000;
/** Wider than two 50 ms snaps. A 100 ms cadence stays one run; a larger hole does not. */
const SPEED_GAP_MS = 100;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface AngleSample {
  serverTimeMs: number;
  pitch: number;
  yaw: number;
  order: number;
}

/**
 * Per-slot lives for one map. A map change is a new tracker; this one does not rename the map.
 * No socket.
 */
export class LifeTracker {
  private readonly lives = new Map<number, Sample[]>();
  /** Earliest own-entity death. Samples at or before this time still belong to that life. */
  private readonly deathAtMs = new Map<number, number>();

  constructor(
    private readonly mapName: string | null,
    private readonly gSpeed: number | null,
  ) {}

  /**
   * Updates the open life for `sample.slot`. An own-entity death stays open for the rest of
   * that server time, so later entities in the same snapshot still count. The closed life is
   * returned on the first later timestamp. `end` closes a life nothing followed.
   */
  push(sample: Sample): LifeFeatures | null {
    const deathAt = this.deathAtMs.get(sample.slot);
    let closed: LifeFeatures | null = null;
    if (
      deathAt !== undefined &&
      Number.isFinite(sample.serverTimeMs) &&
      sample.serverTimeMs > deathAt
    ) {
      closed = this.close(sample.slot, 'death');
    }
    let samples = this.lives.get(sample.slot);
    if (!samples) {
      samples = [];
      this.lives.set(sample.slot, samples);
    }
    samples.push(sample);
    if (
      sample.event === 'death' &&
      sample.entityNum === sample.slot &&
      Number.isFinite(sample.serverTimeMs)
    ) {
      const prev = this.deathAtMs.get(sample.slot);
      if (prev === undefined || sample.serverTimeMs < prev)
        this.deathAtMs.set(sample.slot, sample.serverTimeMs);
    }
    return closed;
  }

  /**
   * Closes the open life. A death already in the samples wins over `reason`, because that
   * life ended when the player died. Null when nothing is open.
   */
  end(slot: number, reason: LifeEnd): LifeFeatures | null {
    if (!this.lives.has(slot)) return null;
    return this.close(slot, this.deathAtMs.has(slot) ? 'death' : reason);
  }

  private close(slot: number, reason: LifeEnd): LifeFeatures | null {
    const samples = this.lives.get(slot);
    if (!samples) return null;
    this.lives.delete(slot);
    this.deathAtMs.delete(slot);
    return buildFeatures(samples, slot, reason, this.mapName, this.gSpeed);
  }
}

function buildFeatures(
  samples: Sample[],
  slot: number,
  endReason: LifeEnd,
  mapName: string | null,
  gSpeed: number | null,
): LifeFeatures {
  const features: LifeFeatures = { slot, endReason, mapName };
  const angles = attackerAngles(samples, slot);
  const enemyTimes = new Set<number>();
  const firstSeen = new Map<number, number>();
  const originAt = new Map<string, Vec3>();

  for (const sample of samples) {
    if (sample.entityNum === slot || !isVec(sample.origin)) continue;
    noteEnemy(firstSeen, sample.entityNum, sample.serverTimeMs);
    originAt.set(
      originKey(sample.entityNum, sample.serverTimeMs),
      sample.origin,
    );
    enemyTimes.add(sample.serverTimeMs);
  }

  const snap = snapOnAcquire(angles, firstSeen, originAt);
  if (snap !== undefined) features.snapOnAcquire = snap;

  const hit = hitFeatures(samples, slot, firstSeen, originAt);
  if (hit.viewErrorAtHit !== undefined)
    features.viewErrorAtHit = hit.viewErrorAtHit;
  if (hit.firedWhileLookingAway !== undefined)
    features.firedWhileLookingAway = hit.firedWhileLookingAway;
  if (hit.timeToDamageMs !== undefined)
    features.timeToDamageMs = hit.timeToDamageMs;

  const yawP95 = angularSpeedP95(angles, enemyTimes);
  if (yawP95 !== undefined) features.angularSpeedP95 = yawP95;

  const speed = speedOverG(samples, slot, gSpeed);
  if (speed !== undefined) features.speedOverG = speed;

  return features;
}

function attackerAngles(samples: Sample[], slot: number): AngleSample[] {
  const angles: AngleSample[] = [];
  samples.forEach((sample, order) => {
    if (sample.entityNum !== slot || !sample.viewangles) return;
    const { pitch, yaw } = sample.viewangles;
    if (
      !Number.isFinite(pitch) ||
      !Number.isFinite(yaw) ||
      !Number.isFinite(sample.serverTimeMs)
    )
      return;
    angles.push({ serverTimeMs: sample.serverTimeMs, pitch, yaw, order });
  });
  return angles;
}

function noteEnemy(
  firstSeen: Map<number, number>,
  entity: number,
  serverTimeMs: number,
): void {
  if (!Number.isFinite(serverTimeMs)) return;
  const prev = firstSeen.get(entity);
  if (prev === undefined || serverTimeMs < prev)
    firstSeen.set(entity, serverTimeMs);
}

function originKey(entity: number, serverTimeMs: number): string {
  return `${entity}:${serverTimeMs}`;
}

/** Largest view-direction change onto an enemy that had four prior angle samples and an origin. */
function snapOnAcquire(
  angles: AngleSample[],
  firstSeen: Map<number, number>,
  originAt: Map<string, Vec3>,
): number | undefined {
  let best: number | undefined;
  for (const [enemy, seenAt] of firstSeen) {
    if (!originAt.has(originKey(enemy, seenAt))) continue;
    const acquisition = lastAngleAt(angles, seenAt);
    if (!acquisition) continue;
    const prior = angles.filter(
      (angle) =>
        angle.serverTimeMs >= seenAt - ACQUIRE_WINDOW_MS &&
        angle.serverTimeMs < seenAt,
    );
    if (prior.length < MIN_ANGLES_BEFORE_ACQUIRE) continue;
    let earliest = prior[0];
    for (const angle of prior) {
      if (
        angle.serverTimeMs < earliest.serverTimeMs ||
        (angle.serverTimeMs === earliest.serverTimeMs &&
          angle.order < earliest.order)
      ) {
        earliest = angle;
      }
    }
    const change = angleBetweenDeg(
      forward(earliest.pitch, earliest.yaw),
      forward(acquisition.pitch, acquisition.yaw),
    );
    if (change === undefined) continue;
    if (best === undefined || change > best) best = change;
  }
  return best;
}

function lastAngleAt(
  angles: AngleSample[],
  serverTimeMs: number,
): AngleSample | undefined {
  let found: AngleSample | undefined;
  for (const angle of angles) {
    if (angle.serverTimeMs === serverTimeMs) found = angle;
  }
  return found;
}

interface HitFeatures {
  viewErrorAtHit?: number;
  firedWhileLookingAway?: number;
  timeToDamageMs?: number;
}

function hitFeatures(
  samples: Sample[],
  slot: number,
  firstSeen: Map<number, number>,
  originAt: Map<string, Vec3>,
): HitFeatures {
  let worstError: number | undefined;
  let worstEnemy: number | undefined;
  let worstTime: number | undefined;
  let earliestDamage: number | undefined;

  for (const sample of samples) {
    if (sample.entityNum !== slot) continue;
    if (sample.event !== 'hit' && sample.event !== 'kill') continue;
    const enemy = sample.otherEntityNum;
    if (enemy === undefined || enemy === slot) continue;
    const seenAt = firstSeen.get(enemy);
    if (seenAt !== undefined && sample.serverTimeMs >= seenAt) {
      const dt = sample.serverTimeMs - seenAt;
      if (earliestDamage === undefined || dt < earliestDamage)
        earliestDamage = dt;
    }
    if (!sample.viewangles || !isVec(sample.origin)) continue;
    const { pitch, yaw } = sample.viewangles;
    if (!Number.isFinite(pitch) || !Number.isFinite(yaw)) continue;
    const enemyOrigin = originAt.get(originKey(enemy, sample.serverTimeMs));
    if (!enemyOrigin) continue;
    const toward = {
      x: enemyOrigin.x - sample.origin.x,
      y: enemyOrigin.y - sample.origin.y,
      z: enemyOrigin.z - sample.origin.z,
    };
    const error = angleBetweenDeg(forward(pitch, yaw), toward);
    if (error === undefined || !Number.isFinite(error)) continue;
    if (worstError === undefined || error > worstError) {
      worstError = error;
      worstEnemy = enemy;
      worstTime = sample.serverTimeMs;
    }
  }

  const features: HitFeatures = {};
  if (worstError !== undefined) {
    features.viewErrorAtHit = worstError;
    if (worstError > LOOKING_AWAY_DEGREES)
      features.firedWhileLookingAway = worstError;
  }
  if (worstEnemy !== undefined && worstTime !== undefined) {
    const seenAt = firstSeen.get(worstEnemy);
    if (seenAt !== undefined && worstTime >= seenAt)
      features.timeToDamageMs = worstTime - seenAt;
  } else if (earliestDamage !== undefined) {
    features.timeToDamageMs = earliestDamage;
  }
  return features;
}

function angularSpeedP95(
  angles: AngleSample[],
  enemyTimes: Set<number>,
): number | undefined {
  if (angles.length < 2 || enemyTimes.size === 0) return undefined;
  const ordered = [...angles].sort(
    (a, b) => a.serverTimeMs - b.serverTimeMs || a.order - b.order,
  );
  const times = [...enemyTimes].sort((a, b) => a - b);
  const rates: number[] = [];
  let hint = 0;
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    const dtMs = curr.serverTimeMs - prev.serverTimeMs;
    if (dtMs <= 0) continue;
    while (hint < times.length && times[hint] <= prev.serverTimeMs) hint++;
    if (hint >= times.length || times[hint] > curr.serverTimeMs) continue;
    const yawStep = Math.abs(wrap180(curr.yaw - prev.yaw));
    rates.push(yawStep / (dtMs / 1000));
  }
  return percentile95(rates);
}

function speedOverG(
  samples: Sample[],
  slot: number,
  gSpeed: number | null,
): number | undefined {
  if (gSpeed === null || !Number.isFinite(gSpeed) || gSpeed <= 0)
    return undefined;
  const limit = SPEED_OVER_G * gSpeed;
  const points: { t: number; ratio: number; above: boolean }[] = [];
  for (const sample of samples) {
    if (sample.entityNum !== slot || !Number.isFinite(sample.serverTimeMs))
      continue;
    let ratio = 0;
    let above = false;
    if (isVec(sample.velocity)) {
      const horizontal = Math.hypot(sample.velocity.x, sample.velocity.y);
      if (Number.isFinite(horizontal)) {
        ratio = horizontal / gSpeed;
        above = horizontal > limit;
      }
    }
    points.push({ t: sample.serverTimeMs, ratio, above });
  }
  points.sort((a, b) => a.t - b.t);

  let best: number | undefined;
  let runStart = -1;
  const finish = (end: number): void => {
    if (runStart < 0) return;
    const run = points.slice(runStart, end);
    const span = run[run.length - 1].t - run[0].t;
    if (span > SPEED_RUN_MS) {
      let maxRatio = run[0].ratio;
      for (const point of run)
        if (point.ratio > maxRatio) maxRatio = point.ratio;
      if (best === undefined || maxRatio > best) best = maxRatio;
    }
    runStart = -1;
  };
  for (let i = 0; i <= points.length; i++) {
    const gap =
      i > 0 &&
      i < points.length &&
      points[i].t - points[i - 1].t > SPEED_GAP_MS;
    if (gap) finish(i);
    const above = i < points.length && points[i].above;
    if (above && runStart < 0) runStart = i;
    else if (!above) finish(i);
  }
  return best !== undefined && Number.isFinite(best) ? best : undefined;
}

function percentile95(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/** Quake 3 AngleVectors. Yaw 0 faces +X, yaw 90 faces +Y, positive pitch faces down. */
function forward(pitchDeg: number, yawDeg: number): Vec3 {
  const pitch = (pitchDeg * Math.PI) / 180;
  const yaw = (yawDeg * Math.PI) / 180;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return { x: cp * cy, y: cp * sy, z: -sp };
}

function angleBetweenDeg(a: Vec3, b: Vec3): number | undefined {
  const am = Math.hypot(a.x, a.y, a.z);
  const bm = Math.hypot(b.x, b.y, b.z);
  if (!Number.isFinite(am) || !Number.isFinite(bm) || am === 0 || bm === 0)
    return undefined;
  const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (am * bm);
  if (!Number.isFinite(dot)) return undefined;
  const clamped = Math.min(1, Math.max(-1, dot));
  const degrees = (Math.acos(clamped) * 180) / Math.PI;
  return Number.isFinite(degrees) ? degrees : undefined;
}

function wrap180(delta: number): number {
  let wrapped = delta % 360;
  if (wrapped > 180) wrapped -= 360;
  if (wrapped < -180) wrapped += 360;
  return wrapped;
}

function isVec(value: Vec3 | undefined): value is Vec3 {
  return (
    value !== undefined &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}
