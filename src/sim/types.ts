// The shared vocabulary of the simulation, and the SimState/SimEvent contract
// that is the ONLY channel between sim/ and world/ (outline: structural rule #2).
//
// Everything here is plain data. No class instances, no functions, no
// three.js types — a snapshot must be safe to hand to a renderer, a test, or
// JSON.stringify without surprises.

/** "10.0.0.1:11111@42" — address plus generation, as in Orleans. */
export type SiloAddress = string;

/** "user/42" — grain type plus key, as in Orleans' GrainId. */
export type GrainId = string;

export type ActivationId = string;

export type RequestId = string;

/** Where a grain currently lives. Orleans calls this a GrainAddress. */
export interface GrainAddress {
  readonly grainId: GrainId;
  readonly activationId: ActivationId;
  readonly silo: SiloAddress;
}

/**
 * Orleans SiloStatus. P0 only ever produces Active; the rest exist now so the
 * P1 membership work does not have to widen a union that world/ already
 * switches on.
 */
export type SiloStatus = 'Created' | 'Joining' | 'Active' | 'ShuttingDown' | 'Stopping' | 'Dead';

/**
 * Activation lifecycle, mirroring Orleans' ActivationState.
 *
 *   Creating     record exists, directory registration in flight
 *   Activating   won registration, OnActivateAsync running
 *   Valid        accepting turns
 *   Deactivating OnDeactivateAsync running, no new turns accepted
 *   Invalid      gone; either collected, lost a registration race, or its silo died
 */
export type ActivationState =
  | 'Creating'
  | 'Activating'
  | 'Valid'
  | 'Deactivating'
  | 'Invalid';

/** Why an activation left the city. Drives which demolition animation plays. */
export type ActivationEndReason = 'lost-registration-race' | 'collected' | 'silo-died';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * A node is anything a vehicle can drive to. world/ maps each of these to an
 * anchor in layout.ts; sim/ never knows the coordinates.
 */
export type NodeRef =
  | { readonly kind: 'client'; readonly id: string }
  | { readonly kind: 'silo'; readonly silo: SiloAddress }
  | { readonly kind: 'directory'; readonly silo: SiloAddress }
  | { readonly kind: 'activation'; readonly silo: SiloAddress; readonly grainId: GrainId }
  /** The membership table — shared storage, not a silo. One per cluster. */
  | { readonly kind: 'townhall' }
  /** Grain storage. External to the cluster, like the membership table. */
  | { readonly kind: 'vault' }
  /** The reminder table plus the service that fires from it. */
  | { readonly kind: 'clocktower' }
  /** A stream pulling agent, one per silo. */
  | { readonly kind: 'pullingagent'; readonly silo: SiloAddress };

export function nodeKey(node: NodeRef): string {
  switch (node.kind) {
    case 'client':
      return `client:${node.id}`;
    case 'silo':
      return `silo:${node.silo}`;
    case 'directory':
      return `dir:${node.silo}`;
    case 'activation':
      return `act:${node.silo}:${node.grainId}`;
    case 'townhall':
      return 'townhall';
    case 'vault':
      return 'vault';
    case 'clocktower':
      return 'clocktower';
    case 'pullingagent':
      return `agent:${node.silo}`;
  }
}

/**
 * The wire protocol. Each variant is one hop a viewer can watch and click.
 * The full cold-call sequence is:
 *
 *   client-request -> dir-lookup -> dir-reply(miss) -> create-activation
 *   -> dir-register -> dir-register-reply -> activation-ready
 *   -> grain-request -> grain-response -> grain-response(to client)
 *
 * A warm call skips straight to grain-request via the caller's local cache.
 * A stale cache entry produces a rejection, which sends it back to dir-lookup.
 */
export type Envelope =
  | { readonly kind: 'client-request'; readonly requestId: RequestId; readonly grainId: GrainId; readonly method: string; readonly clientId: string }
  | { readonly kind: 'dir-lookup'; readonly requestId: RequestId; readonly grainId: GrainId; readonly replyTo: SiloAddress }
  | { readonly kind: 'dir-reply'; readonly requestId: RequestId; readonly grainId: GrainId; readonly address: GrainAddress | undefined }
  | { readonly kind: 'create-activation'; readonly requestId: RequestId; readonly grainId: GrainId; readonly activationId: ActivationId; readonly origin: SiloAddress }
  | { readonly kind: 'dir-register'; readonly requestId: RequestId; readonly candidate: GrainAddress; readonly replyTo: SiloAddress }
  | { readonly kind: 'dir-register-reply'; readonly requestId: RequestId; readonly candidate: GrainAddress; readonly winner: GrainAddress }
  | { readonly kind: 'activation-ready'; readonly requestId: RequestId; readonly grainId: GrainId; readonly address: GrainAddress }
  | { readonly kind: 'grain-request'; readonly requestId: RequestId; readonly grainId: GrainId; readonly method: string; readonly target: GrainAddress; readonly origin: SiloAddress }
  | { readonly kind: 'grain-response'; readonly requestId: RequestId; readonly grainId: GrainId }
  | { readonly kind: 'rejection'; readonly requestId: RequestId; readonly grainId: GrainId; readonly reason: RejectionReason; readonly staleAddress: GrainAddress }
  // -- membership (P1) ------------------------------------------------------
  // Probes are peer-to-peer; IAmAlive and votes are writes to shared storage.
  // Keeping those two paths visually distinct matters: people routinely assume
  // Orleans failure detection goes through the membership table, and it does not.
  | { readonly kind: 'probe'; readonly probeId: string; readonly prober: SiloAddress; readonly target: SiloAddress }
  | { readonly kind: 'probe-ack'; readonly probeId: string; readonly prober: SiloAddress; readonly target: SiloAddress }
  | { readonly kind: 'iam-alive'; readonly silo: SiloAddress }
  | { readonly kind: 'suspect-vote'; readonly voter: SiloAddress; readonly suspect: SiloAddress }
  | { readonly kind: 'membership-update'; readonly version: number; readonly changed: SiloAddress; readonly status: SiloStatus }
  // -- collection (P2) ------------------------------------------------------
  | { readonly kind: 'dir-unregister'; readonly address: GrainAddress }
  // -- grain-to-grain calls (P2) --------------------------------------------
  // A grain calling another grain is the same request path as a client call,
  // except the caller is an activation that STAYS OCCUPIED while it waits.
  // That is what makes call cycles deadlock on non-reentrant grains.
  | { readonly kind: 'grain-call-response'; readonly requestId: RequestId; readonly caller: GrainAddress }
  // -- persistence (P3) -----------------------------------------------------
  | { readonly kind: 'storage-read'; readonly requestId: RequestId; readonly address: GrainAddress }
  | { readonly kind: 'storage-read-reply'; readonly requestId: RequestId; readonly address: GrainAddress; readonly etag: number; readonly version: number }
  | { readonly kind: 'storage-write'; readonly requestId: RequestId; readonly address: GrainAddress; readonly etag: number }
  | { readonly kind: 'storage-write-reply'; readonly requestId: RequestId; readonly address: GrainAddress; readonly etag: number; readonly version: number; readonly conflict: boolean }
  // -- reminders (P3) -------------------------------------------------------
  | { readonly kind: 'reminder-tick'; readonly reminderId: string; readonly grainId: GrainId; readonly requestId: RequestId }
  // -- streams (P3) ---------------------------------------------------------
  | { readonly kind: 'stream-publish'; readonly streamId: string; readonly sequence: number; readonly producer: GrainId }
  | { readonly kind: 'stream-deliver'; readonly streamId: string; readonly sequence: number; readonly subscriber: GrainId; readonly requestId: RequestId };

export type EnvelopeKind = Envelope['kind'];

export type RejectionReason = 'activation-not-here' | 'silo-not-active';

/** A message currently on the road. `progress` is 0..1 for interpolation. */
export interface InFlight {
  readonly id: string;
  readonly envelope: Envelope;
  readonly from: NodeRef;
  readonly to: NodeRef;
  readonly sentAt: number;
  readonly arrivesAt: number;
}

// ---------------------------------------------------------------------------
// Snapshot — what world/ reads each frame
// ---------------------------------------------------------------------------

export interface RingArc {
  readonly silo: SiloAddress;
  /** Arc covers (start, end] on a 0..1 ring, wrapping when start > end. */
  readonly start: number;
  readonly end: number;
}

export interface SiloView {
  readonly address: SiloAddress;
  readonly status: SiloStatus;
  /** Stable index, used by world/ to assign a consistent hue per borough. */
  readonly index: number;
  readonly ringPositions: readonly number[];
  readonly activationCount: number;
  /** Grains this silo is the directory partition owner for. */
  readonly directoryEntryCount: number;
  readonly cacheEntryCount: number;
  /** Last time this silo stamped the membership table. */
  readonly iAmAliveAt: number;
  /** Fresh, unexpired suspicion votes filed against this silo. */
  readonly suspicionVotes: number;
  /** Votes needed to declare it dead right now. */
  readonly votesRequired: number;
  /**
   * The process is gone but the cluster has not concluded it yet. Visible to
   * the viewer immediately; `status` lags until the protocol catches up.
   */
  readonly crashed: boolean;
  /** Silos this one is currently watching. */
  readonly probing: readonly SiloAddress[];
}

export interface ActivationView {
  readonly address: GrainAddress;
  readonly state: ActivationState;
  /** Number of requests waiting outside the revolving door. */
  readonly queueDepth: number;
  /** True while a turn is executing — the building pulses. */
  readonly executing: boolean;
  readonly lastUsedAt: number;
  readonly turnsCompleted: number;
  readonly grainType: string;
  readonly reentrant: boolean;
  /**
   * Occupied by a turn that is waiting on another grain. On a non-reentrant
   * grain this is the state that deadlocks: the activation is busy but doing
   * nothing, and everything behind it in the queue is stuck too.
   */
  readonly blockedOn: GrainId | undefined;
  /** Idle long enough that the collector will take it on its next sweep. */
  readonly collectible: boolean;
  readonly persistent: boolean;
  readonly storageVersion: number;
  readonly storageWrites: number;
  readonly storageConflicts: number;
}

export interface InFlightView {
  readonly id: string;
  readonly kind: EnvelopeKind;
  readonly grainId: GrainId | undefined;
  readonly from: NodeRef;
  readonly to: NodeRef;
  /** 0..1 along the route. */
  readonly progress: number;
}

export interface SimStats {
  readonly requestsStarted: number;
  readonly requestsCompleted: number;
  readonly requestsTimedOut: number;
  readonly directoryHits: number;
  readonly directoryMisses: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly registrationRacesLost: number;
  readonly rejections: number;
  readonly probesSent: number;
  readonly probesMissed: number;
  readonly silosDeclaredDead: number;
  readonly activationsLostToFailure: number;
  readonly activationsCollected: number;
  readonly grainToGrainCalls: number;
  readonly deadlockedActivations: number;
  readonly storageReads: number;
  readonly storageWrites: number;
  readonly storageConflicts: number;
  readonly remindersFired: number;
  readonly streamEventsPublished: number;
  readonly streamEventsDelivered: number;
}

export interface ReminderView {
  readonly id: string;
  readonly grainId: GrainId;
  readonly periodMs: number;
  readonly nextFireAt: number;
  readonly firedCount: number;
}

export interface StreamView {
  readonly id: string;
  readonly producer: GrainId;
  readonly subscribers: readonly GrainId[];
  readonly published: number;
  readonly delivered: number;
  /** Silo whose pulling agent services this stream. */
  readonly agentSilo: SiloAddress | undefined;
}

export interface VaultEntryView {
  readonly grainId: GrainId;
  readonly version: number;
}

export interface VaultView {
  readonly grainCount: number;
  readonly totalVersions: number;
  readonly conflicts: number;
  /** One entry per stored grain, so the vault can draw a cell for each. */
  readonly entries: readonly VaultEntryView[];
}

export interface SimState {
  readonly now: number;
  readonly silos: readonly SiloView[];
  readonly ring: readonly RingArc[];
  readonly activations: readonly ActivationView[];
  readonly inFlight: readonly InFlightView[];
  readonly stats: SimStats;
  readonly reminders: readonly ReminderView[];
  readonly streams: readonly StreamView[];
  readonly vault: VaultView;
}

// ---------------------------------------------------------------------------
// Events — discrete moments worth animating or narrating
// ---------------------------------------------------------------------------

export type SimEvent =
  | { readonly type: 'request-started'; readonly at: number; readonly requestId: RequestId; readonly grainId: GrainId }
  | { readonly type: 'request-completed'; readonly at: number; readonly requestId: RequestId; readonly grainId: GrainId; readonly latency: number }
  | { readonly type: 'message-sent'; readonly at: number; readonly message: InFlight }
  | { readonly type: 'message-delivered'; readonly at: number; readonly message: InFlight }
  | { readonly type: 'cache-hit'; readonly at: number; readonly silo: SiloAddress; readonly grainId: GrainId }
  | { readonly type: 'cache-miss'; readonly at: number; readonly silo: SiloAddress; readonly grainId: GrainId }
  | { readonly type: 'cache-invalidated'; readonly at: number; readonly silo: SiloAddress; readonly grainId: GrainId }
  | { readonly type: 'directory-hit'; readonly at: number; readonly silo: SiloAddress; readonly grainId: GrainId }
  | { readonly type: 'directory-miss'; readonly at: number; readonly silo: SiloAddress; readonly grainId: GrainId }
  | { readonly type: 'placement-decided'; readonly at: number; readonly grainId: GrainId; readonly target: SiloAddress; readonly strategy: string }
  | { readonly type: 'activation-creating'; readonly at: number; readonly address: GrainAddress }
  | { readonly type: 'activation-registered'; readonly at: number; readonly address: GrainAddress }
  | { readonly type: 'activation-valid'; readonly at: number; readonly address: GrainAddress }
  | { readonly type: 'activation-ended'; readonly at: number; readonly address: GrainAddress; readonly reason: ActivationEndReason }
  | { readonly type: 'turn-started'; readonly at: number; readonly address: GrainAddress; readonly requestId: RequestId }
  | { readonly type: 'turn-completed'; readonly at: number; readonly address: GrainAddress; readonly requestId: RequestId }
  | { readonly type: 'request-enqueued'; readonly at: number; readonly address: GrainAddress; readonly requestId: RequestId; readonly queueDepth: number }
  | { readonly type: 'rejected'; readonly at: number; readonly silo: SiloAddress; readonly grainId: GrainId; readonly reason: RejectionReason }
  | { readonly type: 'request-timed-out'; readonly at: number; readonly requestId: RequestId; readonly grainId: GrainId }
  // -- membership (P1) ------------------------------------------------------
  | { readonly type: 'probe-missed'; readonly at: number; readonly prober: SiloAddress; readonly target: SiloAddress; readonly consecutive: number }
  | { readonly type: 'suspicion-voted'; readonly at: number; readonly voter: SiloAddress; readonly suspect: SiloAddress; readonly votes: number; readonly required: number }
  | { readonly type: 'silo-status-changed'; readonly at: number; readonly silo: SiloAddress; readonly from: SiloStatus; readonly to: SiloStatus }
  | { readonly type: 'silo-declared-dead'; readonly at: number; readonly silo: SiloAddress; readonly votes: number }
  | { readonly type: 'directory-partition-lost'; readonly at: number; readonly silo: SiloAddress; readonly entries: number }
  | { readonly type: 'ring-rebuilt'; readonly at: number; readonly activeSilos: number }
  // -- P2 --------------------------------------------------------------------
  | { readonly type: 'collection-swept'; readonly at: number; readonly examined: number; readonly collected: number }
  | { readonly type: 'grain-called-grain'; readonly at: number; readonly caller: GrainAddress; readonly callee: GrainId }
  | { readonly type: 'deadlock-detected'; readonly at: number; readonly cycle: readonly GrainId[] }
  // -- P3 --------------------------------------------------------------------
  | { readonly type: 'storage-read'; readonly at: number; readonly address: GrainAddress; readonly version: number }
  | { readonly type: 'storage-written'; readonly at: number; readonly address: GrainAddress; readonly version: number }
  | { readonly type: 'storage-conflict'; readonly at: number; readonly address: GrainAddress }
  | { readonly type: 'reminder-fired'; readonly at: number; readonly reminderId: string; readonly grainId: GrainId }
  | { readonly type: 'stream-published'; readonly at: number; readonly streamId: string; readonly sequence: number }
  | { readonly type: 'stream-delivered'; readonly at: number; readonly streamId: string; readonly subscriber: GrainId };

export type SimEventType = SimEvent['type'];
