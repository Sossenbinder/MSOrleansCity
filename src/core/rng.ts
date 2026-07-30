// Seeded, deterministic pseudo-random number generation.
//
// Every random choice inside sim/ MUST come from one of these — placement
// decisions, gateway selection, network jitter, workload key distribution.
// Determinism is what makes scenarios reproducible and lets tests assert on
// exact sequences (outline: Key Decisions -> Determinism). Incidental visual
// randomness belongs in engine/, never here.

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). Returns 0 when maxExclusive <= 0. */
  int(maxExclusive: number): number;
  /** Uniform element, or undefined for an empty list. */
  pick<T>(items: readonly T[]): T | undefined;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /**
   * A child generator whose stream is derived from this one's seed and the
   * given label. Lets each subsystem draw independently, so adding a draw in
   * placement/ doesn't shift the numbers the workload generator sees.
   */
  fork(label: string): Rng;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashLabel(label: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);

  const rng: Rng = {
    next,
    int(maxExclusive) {
      if (maxExclusive <= 0) return 0;
      return Math.floor(next() * maxExclusive);
    },
    pick(items) {
      if (items.length === 0) return undefined;
      return items[Math.floor(next() * items.length)];
    },
    range(min, max) {
      return min + next() * (max - min);
    },
    fork(label) {
      return createRng(hashLabel(label, seed));
    },
  };

  return rng;
}
