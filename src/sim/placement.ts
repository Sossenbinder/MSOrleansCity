// Placement directors — the zoning board.
//
// When a grain has no registration anywhere, some silo has to decide which
// borough it gets built in. That decision is the placement strategy, and it is
// per-grain-type in real Orleans ([PreferLocalPlacement] etc. on the grain
// class). Swapping the strategy visibly changes the shape of the city, which
// is the point of putting the zoning board on screen.
//
// StatelessWorkerPlacement is deliberately absent: it is the one strategy that
// breaks the one-activation-per-grain assumption baked into directory.ts and
// activation.ts, so it lands in P2 together with multi-activation support
// rather than being faked here.

import type { Rng } from '../core/rng';
import type { ConsistentRing } from './ring';
import type { GrainId, SiloAddress } from './types';

export type PlacementStrategyId =
  | 'Random'
  | 'PreferLocal'
  | 'ActivationCountBased'
  | 'HashBased';

export interface PlacementContext {
  readonly grainId: GrainId;
  /** The silo running the director — "local" from its point of view. */
  readonly requestingSilo: SiloAddress;
  /** Silos eligible to host. Already filtered to Active by the caller. */
  readonly candidates: readonly SiloAddress[];
  readonly activationCounts: ReadonlyMap<SiloAddress, number>;
  readonly ring: ConsistentRing;
  readonly rng: Rng;
}

export interface PlacementDirector {
  readonly id: PlacementStrategyId;
  readonly label: string;
  /** The Orleans attribute a developer would actually write. */
  readonly attribute: string;
  readonly description: string;
  pick(ctx: PlacementContext): SiloAddress | undefined;
}

const random: PlacementDirector = {
  id: 'Random',
  label: 'Random',
  attribute: '[RandomPlacement]',
  description:
    'Picks a uniformly random compatible silo. Orleans’ default: cheap, ' +
    'stateless, and good enough because grain counts are usually large enough ' +
    'for randomness to balance out on its own.',
  pick: (ctx) => ctx.rng.pick(ctx.candidates),
};

const preferLocal: PlacementDirector = {
  id: 'PreferLocal',
  label: 'Prefer local',
  attribute: '[PreferLocalPlacement]',
  description:
    'Places the grain on the silo that made the call, if it is eligible. ' +
    'Turns a network hop into an in-process call — but concentrates grains ' +
    'wherever traffic enters, so a skewed gateway makes a skewed city.',
  pick: (ctx) => {
    if (ctx.candidates.includes(ctx.requestingSilo)) return ctx.requestingSilo;
    return ctx.rng.pick(ctx.candidates);
  },
};

const activationCountBased: PlacementDirector = {
  id: 'ActivationCountBased',
  label: 'Activation count',
  attribute: '[ActivationCountBasedPlacement]',
  description:
    'Places on the silo currently hosting the fewest activations. Evens out ' +
    'the skyline, at the cost of needing load information that is always ' +
    'slightly out of date.',
  pick: (ctx) => {
    // Ties are broken randomly, NOT by iteration order. This matters more than
    // it looks: a burst of simultaneous cold calls all read the same counts
    // before any activation exists, so deterministic tie-breaking would send
    // every grain in the burst to whichever silo happened to be first —
    // producing the exact pile-up this strategy exists to prevent. That would
    // be an artefact of our iteration order, not a real Orleans behaviour.
    //
    // ACCURACY: real Orleans additionally damps herding by choosing among a
    // random sample of silos rather than the global best. The exact sampling
    // rule is unverified (see config.ts) — random tie-breaking is the minimal
    // correct fix, not a claim to reproduce Orleans' algorithm.
    let bestCount = Number.POSITIVE_INFINITY;
    let tied: SiloAddress[] = [];
    for (const candidate of ctx.candidates) {
      const count = ctx.activationCounts.get(candidate) ?? 0;
      if (count < bestCount) {
        bestCount = count;
        tied = [candidate];
      } else if (count === bestCount) {
        tied.push(candidate);
      }
    }
    return tied.length === 1 ? tied[0] : ctx.rng.pick(tied);
  },
};

const hashBased: PlacementDirector = {
  id: 'HashBased',
  label: 'Hash based',
  attribute: '[HashBasedPlacement]',
  description:
    'Derives the host from the grain id itself, via the same ring used by the ' +
    'directory. Fully deterministic — the same grain lands in the same borough ' +
    'every time, so long as membership does not change.',
  pick: (ctx) => {
    const owner = ctx.ring.ownerOf(ctx.grainId);
    if (owner && ctx.candidates.includes(owner)) return owner;
    return ctx.rng.pick(ctx.candidates);
  },
};

export const PLACEMENT_DIRECTORS: Record<PlacementStrategyId, PlacementDirector> = {
  Random: random,
  PreferLocal: preferLocal,
  ActivationCountBased: activationCountBased,
  HashBased: hashBased,
};

export const DEFAULT_PLACEMENT: PlacementStrategyId = 'Random';

export function directorFor(id: PlacementStrategyId): PlacementDirector {
  return PLACEMENT_DIRECTORS[id];
}
