export type {
  Sample,
  LifeEnd,
  LifeFeatures,
  WatchThresholds,
  PopulationMoments,
  ScoreLifeInput,
  LifeScore,
  PolicyInput,
  PolicyAction,
} from './lib/types.js';
export { DEFAULT_WATCH_THRESHOLDS } from './lib/types.js';
export { LifeTracker } from './lib/tracker.js';
export { scoreLife, decide } from './lib/policy.js';
