// sim/ — the Orleans model.
//
// Pure TypeScript, deterministic, headless-testable. This module never imports
// three.js and never learns anything about geometry; it publishes an immutable
// SimState snapshot plus a typed SimEvent stream, and that is the entire
// contract world/ and ui/ are allowed to depend on.
// (outline: structural rule #2, enforced by eslint.config.js and boundary.test.ts)

export { Cluster } from './cluster';
export { Activation, DEFAULT_GRAIN_TYPE, type GrainType } from './activation';
export { ConsistentRing } from './ring';
export { GrainDirectory } from './directory';
export { Network, progressOf } from './network';
export { advanceTurns } from './scheduler';
export {
  DEFAULT_PLACEMENT,
  PLACEMENT_DIRECTORS,
  directorFor,
  type PlacementDirector,
  type PlacementStrategyId,
} from './placement';
export {
  COUNTS,
  DEFAULT_CONFIG,
  KNOBS,
  allSettings,
  isTimeKnob,
  requiredVotes,
  unverifiedSettings,
  type CountKnob,
  type Knob,
  type KnobId,
  type Setting,
  type SimConfig,
} from './config';
export {
  MembershipTable,
  ProbeTracker,
  isAlive,
  probeTargets,
  type MembershipRow,
} from './membership';
export { hash32, ringPosition } from './hash';
export * from './types';
