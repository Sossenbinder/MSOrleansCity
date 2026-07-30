// Synthetic client traffic.
//
// A city with one call in it teaches the mechanism; a city under steady load
// teaches the behaviour. Traffic is what makes a silo failure legible — you
// watch calls reroute — and what will make P2's hot-grain and queueing
// scenarios mean anything.
//
// Deterministic like everything else in sim/: same seed, same call sequence.

import { createRng, type Rng } from '../core/rng';
import type { GrainId } from './types';

export type KeyDistribution = 'uniform' | 'zipf';

export interface WorkloadOptions {
  /** Calls per simulated second across the whole cluster. */
  readonly callsPerSecond: number;
  /** How many distinct grains the traffic addresses. */
  readonly keySpace: number;
  readonly distribution: KeyDistribution;
  readonly grainType: string;
}

export const DEFAULT_WORKLOAD: WorkloadOptions = {
  // Enough traffic across enough distinct keys that the boroughs fill up and
  // the city reads as populated rather than as a diagram with six labels.
  callsPerSecond: 6,
  keySpace: 90,
  distribution: 'uniform',
  grainType: 'user',
};

export class Workload {
  private readonly rng: Rng;
  /** Fractional calls carried between ticks, so low rates stay accurate. */
  private credit = 0;
  private zipfCdf: number[] = [];

  constructor(
    private options: WorkloadOptions = DEFAULT_WORKLOAD,
    seed = 90210,
  ) {
    this.rng = createRng(seed);
    this.rebuildZipf();
  }

  setOptions(options: WorkloadOptions): void {
    const keySpaceChanged = options.keySpace !== this.options.keySpace;
    this.options = options;
    if (keySpaceChanged) this.rebuildZipf();
  }

  get settings(): WorkloadOptions {
    return this.options;
  }

  /**
   * Zipf with exponent 1: rank r gets weight 1/r. Produces the hot-key skew
   * real systems actually see, where a handful of grains take most of the
   * traffic — which is where single-threaded execution starts to bite.
   */
  private rebuildZipf(): void {
    const weights: number[] = [];
    let total = 0;
    for (let rank = 1; rank <= this.options.keySpace; rank++) {
      total += 1 / rank;
      weights.push(total);
    }
    this.zipfCdf = weights.map((w) => w / total);
  }

  private pickKey(): number {
    if (this.options.distribution === 'uniform') {
      return this.rng.int(this.options.keySpace);
    }
    const roll = this.rng.next();
    for (let i = 0; i < this.zipfCdf.length; i++) {
      if (roll <= (this.zipfCdf[i] ?? 1)) return i;
    }
    return this.options.keySpace - 1;
  }

  /** Emits zero or more calls for this tick. */
  tick(dtMs: number, emit: (grainId: GrainId) => void): void {
    if (this.options.callsPerSecond <= 0) return;
    this.credit += (dtMs / 1000) * this.options.callsPerSecond;

    // Bounded per tick: a long pause or a speed spike must not dump hundreds
    // of calls into the city in a single frame.
    let issued = 0;
    while (this.credit >= 1 && issued < 12) {
      this.credit -= 1;
      issued++;
      emit(`${this.options.grainType}/${this.pickKey()}`);
    }
    if (this.credit > 12) this.credit = 0;
  }

  reset(): void {
    this.credit = 0;
  }
}
