// Grain activations — the buildings.
//
// A grain in Orleans always exists conceptually; an *activation* is the
// in-memory instance that exists only while the grain is being used. That is
// what "virtual actor" means, and it is why buildings here rise on the first
// call and are demolished once idle rather than being placed by hand.
//
// This file owns the lifecycle state machine and the per-activation mailbox.
// Deciding *when* a queued request gets to run is scheduler.ts.

import { newStateHandle, type PersistentStateHandle } from './persistence';
import type { GrainType } from './grainTypes';
import type {
  ActivationState,
  GrainAddress,
  GrainId,
  RequestId,
  SiloAddress,
} from './types';

export { DEFAULT_GRAIN_TYPE, GRAIN_TYPES, grainTypeOf, type GrainType } from './grainTypes';

export interface PendingRequest {
  readonly requestId: RequestId;
  readonly method: string;
  /** Silo to send the response back to. */
  readonly origin: SiloAddress;
  readonly enqueuedAt: number;
}

export interface RunningTurn {
  readonly request: PendingRequest;
  readonly startedAt: number;
  /**
   * When this turn finishes. Infinity while the turn is blocked waiting on
   * another grain — the activation is occupied but doing nothing, which is
   * precisely the state that deadlocks a non-reentrant call cycle.
   */
  endsAt: number;
  /** Grain this turn is waiting on, if any. */
  blockedOn: GrainId | undefined;
  /**
   * Request id of the OUTBOUND call this turn is waiting on — not its own.
   * The two are different ids, and matching on the wrong one means the answer
   * arrives and the turn never wakes up.
   */
  awaitingRequestId: RequestId | undefined;
}

export class Activation {
  state: ActivationState = 'Creating';

  /** Requests waiting outside the revolving door. */
  readonly inbox: PendingRequest[] = [];

  /**
   * Turns currently executing. A list rather than a single slot so [Reentrant]
   * is a cap change rather than a rewrite. For a non-reentrant grain this never
   * exceeds length 1 — asserted in tests.
   */
  readonly running: RunningTurn[] = [];

  /** When Activating, the moment OnActivateAsync finishes. */
  activatingUntil: number | undefined;
  /** When Deactivating, the moment OnDeactivateAsync finishes. */
  deactivatingUntil: number | undefined;

  /** Persistent state, for grain types that declare it. */
  readonly persistentState: PersistentStateHandle = newStateHandle();

  lastUsedAt: number;
  turnsCompleted = 0;

  constructor(
    readonly address: GrainAddress,
    readonly grainType: GrainType,
    createdAt: number,
    /**
     * The silo that ran the placement director and asked for this activation.
     * It is waiting for the resolved address, so it must be told the outcome
     * whether this activation wins its registration race or loses it.
     */
    readonly requestedBy: SiloAddress = address.silo,
  ) {
    this.lastUsedAt = createdAt;
  }

  get grainId(): GrainId {
    return this.address.grainId;
  }

  get silo(): SiloAddress {
    return this.address.silo;
  }

  /** Non-reentrant grains run exactly one turn at a time. */
  get maxConcurrentTurns(): number {
    return this.grainType.reentrant ? Number.POSITIVE_INFINITY : 1;
  }

  get executing(): boolean {
    return this.running.length > 0;
  }

  /** True when it can accept work: activated, not shutting down. */
  get acceptsTurns(): boolean {
    return this.state === 'Valid';
  }

  /** True once it can no longer be routed to. */
  get isGone(): boolean {
    return this.state === 'Invalid';
  }

  /** The grain this activation is currently stuck waiting on, if any. */
  get blockedOn(): GrainId | undefined {
    for (const turn of this.running) {
      if (turn.blockedOn !== undefined) return turn.blockedOn;
    }
    return undefined;
  }

  enqueue(request: PendingRequest): number {
    this.inbox.push(request);
    this.lastUsedAt = request.enqueuedAt;
    return this.inbox.length;
  }

  /** Idle means no turn running and nothing waiting — a collection candidate. */
  isIdle(): boolean {
    return this.running.length === 0 && this.inbox.length === 0;
  }

  idleFor(now: number): number {
    return this.isIdle() ? now - this.lastUsedAt : 0;
  }

  turnFor(requestId: RequestId): RunningTurn | undefined {
    return this.running.find((turn) => turn.request.requestId === requestId);
  }

  /** The turn blocked on a specific outbound call. */
  turnAwaiting(outboundRequestId: RequestId): RunningTurn | undefined {
    return this.running.find((turn) => turn.awaitingRequestId === outboundRequestId);
  }
}
