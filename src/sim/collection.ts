// Activation collection — the demolition crew.
//
// This is what makes a grain "virtual". The grain always exists; the
// activation is just the copy currently in memory, and the runtime is free to
// remove it once nobody has used it recently. Nothing is lost that the grain
// did not explicitly persist, and the next caller silently gets a fresh
// activation without knowing anything happened.
//
// The collector sweeps on a fixed quantum rather than tracking per-grain
// timers, so an activation can sit idle for up to one extra quantum past its
// age limit before anyone comes for it. That slack is not a bug — it is the
// cost of not maintaining a timer per activation in a cluster with millions
// of them.

import type { Activation } from './activation';

export interface CollectionOptions {
  readonly ageLimitMs: number;
  readonly quantumMs: number;
}

export interface CollectionSweep {
  readonly examined: number;
  readonly collected: readonly Activation[];
}

/**
 * An activation is collectible only if it is fully idle: activated, no turn
 * running, and nothing queued. A busy grain is never collected out from under
 * its callers.
 */
export function isCollectible(
  activation: Activation,
  now: number,
  ageLimitMs: number,
): boolean {
  if (activation.state !== 'Valid') return false;
  if (!activation.isIdle()) return false;
  return activation.idleFor(now) >= ageLimitMs;
}

export class Collector {
  private nextSweepAt: number;

  constructor(private options: CollectionOptions) {
    this.nextSweepAt = options.quantumMs;
  }

  setOptions(options: CollectionOptions): void {
    this.options = options;
  }

  get dueAt(): number {
    return this.nextSweepAt;
  }

  /** Returns null when no sweep is due yet. */
  sweep(activations: Iterable<Activation>, now: number): CollectionSweep | null {
    if (now < this.nextSweepAt) return null;
    this.nextSweepAt = now + this.options.quantumMs;

    let examined = 0;
    const collected: Activation[] = [];
    for (const activation of activations) {
      examined++;
      if (isCollectible(activation, now, this.options.ageLimitMs)) collected.push(activation);
    }
    return { examined, collected };
  }
}
