// Grain types — what a developer expresses with attributes on a grain class.
//
// The city needs more than one kind of building because Orleans grains differ
// in ways that change their runtime behaviour visibly:
//
//   [Reentrant]      may interleave turns; without it, one turn at a time
//   persistent state a trip to storage on activate, and again on write
//   calls another    a turn that blocks mid-flight waiting on a second grain
//
// A grain id is "type/key", so the type is read straight off the id — exactly
// as Orleans derives the grain type from the interface you called.

export interface GrainType {
  readonly name: string;
  /** [Reentrant]: turns may interleave at await points. */
  readonly reentrant: boolean;
  /** Uses IPersistentState — reads on activation, writes after turns. */
  readonly persistent: boolean;
  /**
   * Grain type this one calls during a turn. The caller stays occupied for the
   * whole round trip, which is what makes a call cycle deadlock unless one of
   * the participants is reentrant.
   */
  readonly calls?: string;
  readonly description: string;
}

function grain(t: GrainType): GrainType {
  return t;
}

export const GRAIN_TYPES: Record<string, GrainType> = {
  user: grain({
    name: 'user',
    reentrant: false,
    persistent: false,
    description: 'A plain grain. One turn at a time, no state, no outbound calls.',
  }),

  order: grain({
    name: 'order',
    reentrant: false,
    persistent: false,
    description: 'A second plain grain type, so the city is not monochrome.',
  }),

  account: grain({
    name: 'account',
    reentrant: false,
    persistent: true,
    description:
      'Persistent state. Reads from storage as part of activation, and writes back ' +
      'after each turn under an ETag — so a stale writer is rejected rather than ' +
      'silently overwriting a newer version.',
  }),

  ledger: grain({
    name: 'ledger',
    reentrant: false,
    persistent: true,
    description:
      'Persistent, and the target of a durable reminder. Reminders reactivate a ' +
      'grain that has been collected, which is why a ledger keeps ticking even ' +
      'when nobody is calling it.',
  }),

  // The deadlock pair. alpha/1 calls beta/1, which calls alpha/1 straight back.
  alpha: grain({
    name: 'alpha',
    reentrant: false,
    persistent: false,
    calls: 'beta',
    description:
      'Calls beta during its turn and stays occupied for the whole round trip. ' +
      'Paired with beta this forms a call cycle, and because neither is reentrant ' +
      'the cycle deadlocks until the request timeout breaks it.',
  }),

  beta: grain({
    name: 'beta',
    reentrant: false,
    persistent: false,
    calls: 'alpha',
    description:
      'Calls alpha straight back. The other half of the deadlock demonstration.',
  }),

  // The same cycle, but reentrant — the fix, side by side with the bug.
  gamma: grain({
    name: 'gamma',
    reentrant: true,
    persistent: false,
    calls: 'delta',
    description:
      '[Reentrant] version of alpha. Because it admits another turn while waiting, ' +
      'the call cycle with delta completes instead of deadlocking.',
  }),

  delta: grain({
    name: 'delta',
    reentrant: true,
    persistent: false,
    calls: 'gamma',
    description: '[Reentrant] counterpart to gamma.',
  }),

  feed: grain({
    name: 'feed',
    reentrant: false,
    persistent: false,
    description: 'Stream subscriber. Each delivered event is an ordinary turn.',
  }),
};

export const DEFAULT_GRAIN_TYPE: GrainType = GRAIN_TYPES['user'] ?? {
  name: 'user',
  reentrant: false,
  persistent: false,
  description: '',
};

/** "account/17" -> the account grain type. Unknown prefixes fall back to plain. */
export function grainTypeOf(grainId: string): GrainType {
  const name = grainId.split('/')[0] ?? 'user';
  return GRAIN_TYPES[name] ?? { ...DEFAULT_GRAIN_TYPE, name };
}

export function grainKeyOf(grainId: string): string {
  return grainId.split('/')[1] ?? '0';
}

/** The grain `grainId` would call, keeping the same key. */
export function calleeOf(grainId: string): string | undefined {
  const type = grainTypeOf(grainId);
  if (!type.calls) return undefined;
  return `${type.calls}/${grainKeyOf(grainId)}`;
}

/**
 * Call depth, encoded in the method name.
 *
 * Needed because a mutually-calling pair would otherwise recurse forever: every
 * turn of gamma calls delta, including the turn that arrived FROM delta. Real
 * grain methods have logic that terminates; ours needs an explicit bound.
 *
 * Depth 2 is the smallest bound that still shows both outcomes:
 *
 *   alpha(0) -> beta(1) -> alpha(2)   alpha is non-reentrant and still busy at
 *                                     depth 0, so the depth-2 turn never runs.
 *                                     Deadlock.
 *   gamma(0) -> delta(1) -> gamma(2)  gamma is [Reentrant], so it admits the
 *                                     depth-2 turn while still waiting. That
 *                                     turn is at the bound, makes no further
 *                                     call, and the whole chain unwinds.
 */
export const MAX_CALL_DEPTH = 2;

export function callDepth(method: string): number {
  const match = /^Callback:(\d+)$/.exec(method);
  return match?.[1] ? Number(match[1]) : 0;
}

export function nextCallMethod(method: string): string {
  return `Callback:${callDepth(method) + 1}`;
}

export function mayCallOut(method: string): boolean {
  return callDepth(method) < MAX_CALL_DEPTH;
}
