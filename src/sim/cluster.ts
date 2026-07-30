// The cluster — the city itself, and the router that drives every vehicle on it.
//
// This file owns the P0 story end to end. The cold-call path is deliberately
// modelled hop by hop rather than short-circuited, because each hop is a thing
// the city is trying to teach:
//
//   1  client-request      a call enters through a gateway silo
//   2  dir-lookup          gateway's local cache missed; ask the partition owner
//   3  dir-reply (miss)    nobody has registered this grain anywhere
//   4  create-activation   the zoning board picked a borough; build there
//   5  dir-register        the new activation claims the grain in the registry
//   6  dir-register-reply  first-writer-wins resolves the claim
//   7  activation-ready    the resolved address goes back to the gateway
//   8  grain-request       the call finally reaches the building
//   9  grain-response      the turn finished
//  10  grain-response      gateway hands the answer back to the client
//
// A warm call collapses this to 1 -> 8 -> 9 -> 10 via the gateway's cache. A
// stale cache entry produces a rejection at step 8, which invalidates and
// rejoins at step 2 — which is exactly how real Orleans repairs its caches.

import { createBus, type Bus } from '../core/bus';
import { createRng, type Rng } from '../core/rng';
import { Activation } from './activation';
import { Collector, isCollectible } from './collection';
import {
  COUNTS,
  DEFAULT_CONFIG,
  resolveKnobs,
  type KnobId,
  type SimConfig,
} from './config';
import { GrainDirectory } from './directory';
import { calleeOf, grainTypeOf, mayCallOut, nextCallMethod } from './grainTypes';
import { MembershipTable, ProbeTracker, probeTargets } from './membership';
import { Network, progressOf } from './network';
import { GrainStorage } from './persistence';
import {
  DEFAULT_PLACEMENT,
  directorFor,
  type PlacementStrategyId,
} from './placement';
import { ReminderTable } from './reminders';
import { ConsistentRing } from './ring';
import { advanceTurns, findDeadlocks, resumeTurn } from './scheduler';
import { StreamRegistry } from './streams';
import type {
  ActivationView,
  Envelope,
  GrainAddress,
  GrainId,
  InFlight,
  InFlightView,
  NodeRef,
  RequestId,
  SiloAddress,
  SiloStatus,
  SimEvent,
  SimState,
  SimStats,
  SiloView,
} from './types';

interface Silo {
  readonly address: SiloAddress;
  readonly index: number;
  status: SiloStatus;
  readonly activations: Map<GrainId, Activation>;
  /**
   * The process is gone, but the CLUSTER does not know yet. Between crashing
   * and being declared Dead a silo is a black hole: it answers nothing and
   * emits nothing, while everyone else still routes to it. That window is
   * where the interesting failure behaviour lives.
   */
  crashed?: boolean;
}

/**
 * Who is waiting for this call. A grain call is not special-cased in the
 * routing — it takes exactly the same path as a client call — but the answer
 * goes somewhere different, and in the grain case it un-blocks a turn.
 */
type RequestOrigin =
  | { readonly kind: 'client'; readonly clientId: string }
  | { readonly kind: 'grain'; readonly caller: GrainAddress }
  | { readonly kind: 'reminder'; readonly reminderId: string }
  | { readonly kind: 'stream'; readonly streamId: string };

interface PendingCall {
  readonly requestId: RequestId;
  readonly grainId: GrainId;
  readonly method: string;
  readonly startedAt: number;
  readonly origin: RequestOrigin;
  /** Silo that entered this call into the cluster and does the lookup. */
  readonly entrySilo: SiloAddress;
}

const CLIENT_ID = 'client-0';

export class Cluster {
  readonly events: Bus<SimEvent> = createBus<SimEvent>();

  private config: SimConfig;
  private now = 0;

  private readonly silos = new Map<SiloAddress, Silo>();
  private readonly ring = new ConsistentRing();
  private readonly directory = new GrainDirectory();
  private readonly network: Network;
  private readonly membership = new MembershipTable();
  private readonly probes = new ProbeTracker();

  /** Per-silo timers for the two independent liveness signals. */
  private readonly nextProbeAt = new Map<SiloAddress, number>();
  private readonly nextIAmAliveAt = new Map<SiloAddress, number>();

  private readonly placementRng: Rng;
  private readonly gatewayRng: Rng;

  private readonly pending = new Map<RequestId, PendingCall>();

  private readonly storage = new GrainStorage();
  private readonly reminders = new ReminderTable();
  private readonly streams = new StreamRegistry();
  private readonly collector: Collector;

  private placementStrategy: PlacementStrategyId = DEFAULT_PLACEMENT;

  private nextRequestId = 0;
  private nextActivationId = 0;
  /** Deadlock cycles already reported, so the event fires once per cycle. */
  private readonly reportedDeadlocks = new Set<string>();

  private stats = freshStats();

  /** Resolved knob values in simulated ms, after any per-run overrides. */
  private readonly k: Record<KnobId, number>;

  constructor(config: SimConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.k = resolveKnobs(config.knobs);
    const rootRng = createRng(config.seed);
    this.placementRng = rootRng.fork('placement');
    this.gatewayRng = rootRng.fork('gateway');
    this.network = new Network(rootRng.fork('network'), {
      hopMs: this.k.networkHop,
      jitter: 0.15,
    });
    this.collector = new Collector({
      ageLimitMs: this.k.collectionAgeLimit,
      quantumMs: this.k.collectionQuantum,
    });
    this.buildSilos();
  }

  // -- construction ---------------------------------------------------------

  private buildSilos(): void {
    for (let i = 0; i < this.config.siloCount; i++) {
      const address: SiloAddress = `10.0.0.${i + 1}:11111@1`;
      this.silos.set(address, {
        address,
        index: i,
        status: 'Active',
        activations: new Map(),
      });
      // Stagger the timers so the whole cluster does not heartbeat in lockstep.
      this.nextProbeAt.set(address, (this.k.probeInterval * i) / this.config.siloCount);
      this.nextIAmAliveAt.set(
        address,
        (this.k.iAmAlivePublish * i) / this.config.siloCount,
      );
    }
    this.membership.seed([...this.silos.keys()], 0);
    this.rebuildRing();
  }

  private rebuildRing(): void {
    this.ring.rebuild(
      [...this.silos.values()].map((s) => ({ address: s.address, status: s.status })),
      this.config.virtualBucketsPerSilo,
    );
    this.emit({ type: 'ring-rebuilt', at: this.now, activeSilos: this.activeSilos().length });
  }

  private activeSilos(): SiloAddress[] {
    return [...this.silos.values()]
      .filter((s) => s.status === 'Active')
      .map((s) => s.address);
  }

  // -- public API -----------------------------------------------------------

  get time(): number {
    return this.now;
  }

  get placement(): PlacementStrategyId {
    return this.placementStrategy;
  }

  setPlacement(strategy: PlacementStrategyId): void {
    this.placementStrategy = strategy;
  }

  siloAddresses(): SiloAddress[] {
    return [...this.silos.keys()];
  }

  private beginCall(call: PendingCall): RequestId {
    this.pending.set(call.requestId, call);
    this.stats.requestsStarted++;
    this.emit({
      type: 'request-started',
      at: this.now,
      requestId: call.requestId,
      grainId: call.grainId,
    });
    return call.requestId;
  }

  /**
   * Injects a client call. Returns the request id so callers (tour, tests) can
   * follow one specific vehicle through the city.
   */
  callGrain(grainId: GrainId, method = 'Say', gateway?: SiloAddress): RequestId | undefined {
    const candidates = this.activeSilos();
    if (candidates.length === 0) return undefined;
    const entry = gateway && this.silos.get(gateway)?.status === 'Active'
      ? gateway
      : this.gatewayRng.pick(candidates);
    if (!entry) return undefined;

    const requestId = this.beginCall({
      requestId: `r${this.nextRequestId++}`,
      grainId,
      method,
      startedAt: this.now,
      origin: { kind: 'client', clientId: CLIENT_ID },
      entrySilo: entry,
    });

    this.send(
      { kind: 'client-request', requestId, grainId, method, clientId: CLIENT_ID },
      { kind: 'client', id: CLIENT_ID },
      { kind: 'silo', silo: entry },
    );
    return requestId;
  }

  /**
   * A grain calling another grain. Identical routing to a client call — the
   * caller does a directory lookup like anyone else — but the answer comes
   * back to the calling activation and un-blocks its turn.
   */
  private callGrainFromGrain(caller: GrainAddress, callee: GrainId, method: string): RequestId {
    const requestId = this.beginCall({
      requestId: `r${this.nextRequestId++}`,
      grainId: callee,
      method,
      startedAt: this.now,
      origin: { kind: 'grain', caller },
      entrySilo: caller.silo,
    });
    this.stats.grainToGrainCalls++;
    this.emit({ type: 'grain-called-grain', at: this.now, caller, callee });
    this.routeRequest(requestId, callee, caller.silo);
    return requestId;
  }

  /** Registers a durable reminder against a grain. */
  registerReminder(grainId: GrainId, periodMs = this.k.reminderPeriod): string {
    return this.reminders.register(grainId, periodMs, this.now).id;
  }

  unregisterReminder(reminderId: string): boolean {
    return this.reminders.unregister(reminderId);
  }

  /** Creates a stream with a producer and a fixed subscriber set. */
  createStream(id: string, producer: GrainId, subscribers: GrainId[]): void {
    this.streams.create(id, producer, subscribers, this.now + this.k.streamPublishInterval);
  }

  streamIds(): string[] {
    return this.streams.all().map((s) => s.id);
  }

  /**
   * Kills a silo the way a crashed process dies: no goodbye, no state handed
   * over, nothing flushed. The cluster is not told — it has to work it out,
   * which is the entire point of the membership protocol.
   */
  killSilo(address: SiloAddress): boolean {
    const silo = this.silos.get(address);
    if (!silo || silo.status === 'Dead') return false;
    silo.crashed = true;
    return true;
  }

  /** Advances simulated time by `dtMs` and processes everything due. */
  tick(dtMs: number): void {
    if (dtMs <= 0) return;
    this.now += dtMs;

    for (const message of this.network.collectArrived(this.now)) {
      this.emit({ type: 'message-delivered', at: this.now, message });
      this.deliver(message);
    }

    this.tickMembership();
    this.expireRequests();
    this.advanceActivationStates();

    advanceTurns(this.allActivations(), this.now,
      { turnDurationMs: this.k.turnDuration },
      {
        onTurnStarted: (address, requestId, method) => {
          this.emit({ type: 'turn-started', at: this.now, address, requestId });

          // A grain type that calls another issues that call as its turn
          // begins, and then waits. Returning the callee tells the scheduler
          // to keep this activation occupied until the answer comes back.
          const callee = calleeOf(address.grainId);
          if (!callee || !mayCallOut(method)) return undefined;
          const awaitingRequestId = this.callGrainFromGrain(
            address,
            callee,
            nextCallMethod(method),
          );
          return { blockedOn: callee, awaitingRequestId };
        },
        onTurnCompleted: (address, requestId, origin) => {
          this.emit({ type: 'turn-completed', at: this.now, address, requestId });
          this.writeStateIfPersistent(address, requestId);
          this.send(
            { kind: 'grain-response', requestId, grainId: address.grainId },
            { kind: 'activation', silo: address.silo, grainId: address.grainId },
            { kind: 'silo', silo: origin },
          );
        },
      },
    );

    this.tickCollection();
    this.tickReminders();
    this.tickStreams();
    this.detectDeadlocks();
  }

  // -- P2: collection, deadlocks --------------------------------------------

  private tickCollection(): void {
    const sweep = this.collector.sweep(this.allActivations(), this.now);
    if (!sweep) return;

    this.emit({
      type: 'collection-swept',
      at: this.now,
      examined: sweep.examined,
      collected: sweep.collected.length,
    });

    for (const activation of sweep.collected) {
      activation.state = 'Deactivating';
      activation.deactivatingUntil = this.now + this.k.deactivationDuration;
    }
  }

  /**
   * Reports call cycles. Nothing is broken here on purpose — Orleans does not
   * detect deadlocks either, and the request timeout is what eventually frees
   * the participants. Surfacing it is the teaching value.
   */
  private detectDeadlocks(): void {
    for (const cycle of findDeadlocks(this.allActivations())) {
      const key = [...cycle].sort().join('->');
      if (this.reportedDeadlocks.has(key)) continue;
      this.reportedDeadlocks.add(key);
      this.stats.deadlockedActivations += cycle.length;
      this.emit({ type: 'deadlock-detected', at: this.now, cycle });
    }
  }

  // -- P3: reminders and streams --------------------------------------------

  private tickReminders(): void {
    for (const reminder of this.reminders.collectDue(this.now)) {
      const entry = this.gatewayRng.pick(this.activeSilos());
      if (!entry) continue;

      this.stats.remindersFired++;
      this.emit({
        type: 'reminder-fired',
        at: this.now,
        reminderId: reminder.id,
        grainId: reminder.grainId,
      });

      const requestId = this.beginCall({
        requestId: `r${this.nextRequestId++}`,
        grainId: reminder.grainId,
        method: 'ReceiveReminder',
        startedAt: this.now,
        origin: { kind: 'reminder', reminderId: reminder.id },
        entrySilo: entry,
      });

      // Fires from the clock tower, not from a silo — a reminder is delivered
      // by the reminder service, and it will ACTIVATE the grain to do it.
      this.send(
        { kind: 'reminder-tick', reminderId: reminder.id, grainId: reminder.grainId, requestId },
        { kind: 'clocktower' },
        { kind: 'silo', silo: entry },
      );
    }
  }

  private tickStreams(): void {
    const active = this.activeSilos();
    for (const stream of this.streams.collectDue(this.now, this.k.streamPublishInterval)) {
      const agent = StreamRegistry.agentFor(stream.id, active);
      if (!agent) continue;

      this.stats.streamEventsPublished++;
      this.emit({
        type: 'stream-published',
        at: this.now,
        streamId: stream.id,
        sequence: stream.sequence,
      });

      // Producer -> the pulling agent that owns this stream.
      this.send(
        { kind: 'stream-publish', streamId: stream.id, sequence: stream.sequence, producer: stream.producer },
        { kind: 'silo', silo: agent },
        { kind: 'pullingagent', silo: agent },
      );

      // The agent fans out to every subscriber. Each delivery is an ordinary
      // grain call, so a deactivated subscriber is reactivated to receive it.
      for (const subscriber of stream.subscribers) {
        const requestId = this.beginCall({
          requestId: `r${this.nextRequestId++}`,
          grainId: subscriber,
          method: 'OnNextAsync',
          startedAt: this.now,
          origin: { kind: 'stream', streamId: stream.id },
          entrySilo: agent,
        });
        this.send(
          { kind: 'stream-deliver', streamId: stream.id, sequence: stream.sequence, subscriber, requestId },
          { kind: 'pullingagent', silo: agent },
          { kind: 'silo', silo: agent },
        );
      }
    }
  }

  private writeStateIfPersistent(address: GrainAddress, requestId: RequestId): void {
    const activation = this.silos.get(address.silo)?.activations.get(address.grainId);
    if (!activation || !activation.grainType.persistent) return;

    this.send(
      {
        kind: 'storage-write',
        requestId,
        address,
        etag: activation.persistentState.etag,
      },
      { kind: 'activation', silo: address.silo, grainId: address.grainId },
      { kind: 'vault' },
    );
  }

  // -- routing --------------------------------------------------------------

  /**
   * A crashed or dead silo receives nothing. Note there is no "sorry, I'm
   * down" reply — a crashed process cannot send one. Callers find out by
   * timing out, which is exactly how it works in reality and why the request
   * timeout matters more than it first appears.
   */
  private reachable(node: NodeRef): boolean {
    const silo = this.siloOf(node);
    // Client, town hall, vault and clock tower all live outside the cluster
    // and are unaffected by any silo failing.
    if (silo === undefined) return true;
    const host = this.silos.get(silo);
    return host !== undefined && !host.crashed && host.status !== 'Dead';
  }

  private deliver(message: InFlight): void {
    if (!this.reachable(message.to)) return;

    const envelope = message.envelope;
    switch (envelope.kind) {
      case 'client-request':
      case 'reminder-tick':
      case 'stream-deliver': {
        // All three enter the cluster the same way: a silo receives them and
        // routes to the grain, activating it if it is not currently anywhere.
        const entry = this.siloOf(message.to);
        const grainId =
          envelope.kind === 'stream-deliver' ? envelope.subscriber : envelope.grainId;
        if (envelope.kind === 'stream-deliver') this.streams.recordDelivery(envelope.streamId);
        if (entry) this.routeRequest(envelope.requestId, grainId, entry);
        return;
      }

      case 'stream-publish':
        // Arrived at the pulling agent; fan-out already scheduled alongside it.
        return;

      case 'dir-unregister': {
        const owner = this.siloOf(message.to);
        if (!owner) return;
        this.directory.unregister(owner, envelope.address.grainId, envelope.address.activationId);
        return;
      }

      case 'grain-call-response': {
        const activation = this.silos
          .get(envelope.caller.silo)
          ?.activations.get(envelope.caller.grainId);
        if (!activation) return;
        resumeTurn(activation, envelope.requestId, this.now, {
          turnDurationMs: this.k.turnDuration,
        });
        return;
      }

      case 'storage-read': {
        const stored = this.storage.read(envelope.address.grainId);
        this.stats.storageReads++;
        this.emit({
          type: 'storage-read',
          at: this.now,
          address: envelope.address,
          version: stored.version,
        });
        this.send(
          {
            kind: 'storage-read-reply',
            requestId: envelope.requestId,
            address: envelope.address,
            etag: stored.etag,
            version: stored.version,
          },
          { kind: 'vault' },
          { kind: 'activation', silo: envelope.address.silo, grainId: envelope.address.grainId },
        );
        return;
      }

      case 'storage-read-reply': {
        const activation = this.silos
          .get(envelope.address.silo)
          ?.activations.get(envelope.address.grainId);
        if (!activation || activation.address.activationId !== envelope.address.activationId) return;
        activation.persistentState.etag = envelope.etag;
        activation.persistentState.version = envelope.version;
        activation.persistentState.loaded = true;
        // State is loaded; only now can OnActivateAsync finish.
        activation.activatingUntil = this.now + this.k.activationDuration;
        return;
      }

      case 'storage-write': {
        const result = this.storage.write(envelope.address.grainId, envelope.etag);
        this.stats.storageWrites++;
        if (result.accepted) {
          this.emit({
            type: 'storage-written',
            at: this.now,
            address: envelope.address,
            version: result.version,
          });
        } else {
          this.stats.storageConflicts++;
          this.emit({ type: 'storage-conflict', at: this.now, address: envelope.address });
        }
        this.send(
          {
            kind: 'storage-write-reply',
            requestId: envelope.requestId,
            address: envelope.address,
            etag: result.etag,
            version: result.version,
            conflict: !result.accepted,
          },
          { kind: 'vault' },
          { kind: 'activation', silo: envelope.address.silo, grainId: envelope.address.grainId },
        );
        return;
      }

      case 'storage-write-reply': {
        const activation = this.silos
          .get(envelope.address.silo)
          ?.activations.get(envelope.address.grainId);
        if (!activation) return;
        // On conflict the writer adopts what storage actually holds — the
        // real equivalent is catching InconsistentStateException and re-reading.
        activation.persistentState.etag = envelope.etag;
        activation.persistentState.version = envelope.version;
        if (envelope.conflict) activation.persistentState.conflicts++;
        else activation.persistentState.writes++;
        return;
      }

      case 'dir-lookup': {
        const owner = this.siloOf(message.to);
        if (!owner) return;
        const found = this.directory.lookup(owner, envelope.grainId);
        this.emit({
          type: found ? 'directory-hit' : 'directory-miss',
          at: this.now,
          silo: owner,
          grainId: envelope.grainId,
        });
        if (found) this.stats.directoryHits++;
        else this.stats.directoryMisses++;

        this.send(
          { kind: 'dir-reply', requestId: envelope.requestId, grainId: envelope.grainId, address: found },
          { kind: 'directory', silo: owner },
          { kind: 'silo', silo: envelope.replyTo },
        );
        return;
      }

      case 'dir-reply': {
        const at = this.siloOf(message.to);
        if (!at) return;
        if (envelope.address) {
          this.directory.cachePut(at, envelope.address);
          this.sendGrainRequest(envelope.requestId, envelope.address, at);
        } else {
          this.placeAndCreate(envelope.requestId, envelope.grainId, at);
        }
        return;
      }

      case 'create-activation': {
        const host = this.siloOf(message.to);
        if (!host) return;
        this.onCreateActivation(envelope.requestId, envelope.grainId, envelope.activationId, host, envelope.origin);
        return;
      }

      case 'dir-register': {
        const owner = this.siloOf(message.to);
        if (!owner) return;
        const result = this.directory.register(owner, envelope.candidate);
        this.send(
          {
            kind: 'dir-register-reply',
            requestId: envelope.requestId,
            candidate: envelope.candidate,
            winner: result.winner,
          },
          { kind: 'directory', silo: owner },
          { kind: 'silo', silo: envelope.candidate.silo },
        );
        return;
      }

      case 'dir-register-reply':
        this.onRegisterReply(envelope.requestId, envelope.candidate, envelope.winner);
        return;

      case 'activation-ready': {
        const at = this.siloOf(message.to);
        if (!at) return;
        this.directory.cachePut(at, envelope.address);
        this.sendGrainRequest(envelope.requestId, envelope.address, at);
        return;
      }

      case 'grain-request':
        this.onGrainRequest(envelope.requestId, envelope.target, envelope.method, envelope.origin);
        return;

      case 'grain-response':
        this.onGrainResponse(envelope.requestId, envelope.grainId, message.to);
        return;

      case 'rejection': {
        const at = this.siloOf(message.to);
        if (!at) return;
        this.stats.rejections++;
        this.directory.cacheInvalidate(at, envelope.grainId);
        this.emit({ type: 'cache-invalidated', at: this.now, silo: at, grainId: envelope.grainId });
        // Rejoin the cold path: ask the authoritative partition again.
        this.askDirectory(envelope.requestId, envelope.grainId, at);
        return;
      }

      case 'probe':
        // Reaching here means the target answered, so it is up.
        this.send(
          {
            kind: 'probe-ack',
            probeId: envelope.probeId,
            prober: envelope.prober,
            target: envelope.target,
          },
          { kind: 'silo', silo: envelope.target },
          { kind: 'silo', silo: envelope.prober },
        );
        return;

      case 'probe-ack':
        this.probes.acknowledge(envelope.probeId);
        return;

      case 'iam-alive':
        this.membership.recordIAmAlive(envelope.silo, this.now);
        return;

      case 'suspect-vote':
        this.onSuspicionVote(envelope.voter, envelope.suspect);
        return;

      case 'membership-update': {
        const at = this.siloOf(message.to);
        if (!at || envelope.status !== 'Dead') return;
        // Each silo prunes its own cache when the news reaches it.
        const dropped = this.directory.cacheInvalidateHostedOn(at, envelope.changed);
        if (dropped > 0) {
          this.emit({
            type: 'cache-invalidated',
            at: this.now,
            silo: at,
            grainId: `${dropped} entries on ${envelope.changed}`,
          });
        }
        return;
      }
    }
  }

  // -- membership ------------------------------------------------------------

  private tickMembership(): void {
    this.membership.pruneVotes(this.now, this.k.deathVoteExpiration);

    // Unanswered pings become misses; enough consecutive misses become a vote.
    for (const missed of this.probes.collectExpired(this.now)) {
      this.stats.probesMissed++;
      this.emit({
        type: 'probe-missed',
        at: this.now,
        prober: missed.prober,
        target: missed.target,
        consecutive: missed.consecutive,
      });

      if (missed.consecutive < COUNTS.numMissedProbesLimit.simulated) continue;
      const prober = this.silos.get(missed.prober);
      if (!prober || prober.crashed || prober.status !== 'Active') continue;
      this.send(
        { kind: 'suspect-vote', voter: missed.prober, suspect: missed.target },
        { kind: 'silo', silo: missed.prober },
        { kind: 'townhall' },
      );
    }

    const active = this.activeSilos();
    for (const silo of this.silos.values()) {
      if (silo.status !== 'Active' || silo.crashed) continue;

      const probeDue = this.nextProbeAt.get(silo.address) ?? 0;
      if (this.now >= probeDue) {
        this.nextProbeAt.set(silo.address, this.now + this.k.probeInterval);
        for (const target of probeTargets(silo.address, active)) {
          if (this.probes.hasOutstanding(silo.address, target)) continue;
          const probeId = this.probes.issue(
            silo.address,
            target,
            this.now + this.k.probeTimeout,
          );
          this.stats.probesSent++;
          this.send(
            { kind: 'probe', probeId, prober: silo.address, target },
            { kind: 'silo', silo: silo.address },
            { kind: 'silo', silo: target },
          );
        }
      }

      const aliveDue = this.nextIAmAliveAt.get(silo.address) ?? 0;
      if (this.now >= aliveDue) {
        this.nextIAmAliveAt.set(silo.address, this.now + this.k.iAmAlivePublish);
        this.send(
          { kind: 'iam-alive', silo: silo.address },
          { kind: 'silo', silo: silo.address },
          { kind: 'townhall' },
        );
      }
    }
  }

  private onSuspicionVote(voter: SiloAddress, suspect: SiloAddress): void {
    const row = this.membership.row(suspect);
    if (!row || row.status === 'Dead') return;

    this.membership.addSuspicion(suspect, voter, this.now);
    const votes = this.membership.freshVotes(
      suspect,
      this.now,
      this.k.deathVoteExpiration,
    );
    const required = this.membership.votesRequiredFor();
    this.emit({
      type: 'suspicion-voted',
      at: this.now,
      voter,
      suspect,
      votes: votes.length,
      required,
    });

    if (votes.length >= required) this.declareDead(suspect, votes.length);
  }

  /**
   * The cluster has concluded a silo is gone. Everything below follows from
   * one fact: an activation is in-memory state on a process that no longer
   * exists. Orleans does not checkpoint grains for you, so nothing is
   * recovered — the grains simply activate again, fresh, somewhere else, the
   * next time somebody calls them.
   */
  private declareDead(address: SiloAddress, votes: number): void {
    const silo = this.silos.get(address);
    if (!silo || silo.status === 'Dead') return;

    const previous = this.membership.setStatus(address, 'Dead');
    silo.status = 'Dead';
    this.probes.forget(address);
    this.stats.silosDeclaredDead++;
    if (previous) {
      this.emit({
        type: 'silo-status-changed',
        at: this.now,
        silo: address,
        from: previous,
        to: 'Dead',
      });
    }
    this.emit({ type: 'silo-declared-dead', at: this.now, silo: address, votes });

    // 1. Its activations are gone.
    for (const activation of silo.activations.values()) {
      activation.state = 'Invalid';
      this.stats.activationsLostToFailure++;
      this.emit({
        type: 'activation-ended',
        at: this.now,
        address: activation.address,
        reason: 'silo-died',
      });
    }
    silo.activations.clear();

    // 2. Registrations POINTING at it, held in surviving silos' partitions.
    //    Resolved against the pre-rebuild ring, because that is where those
    //    registrations still live.
    for (const registration of this.directory.registrationsHostedOn(address)) {
      const owner = this.ring.ownerOf(registration.grainId);
      if (owner) {
        this.directory.unregister(owner, registration.grainId, registration.activationId);
      }
    }

    // 3. The partition it OWNED is lost outright. An in-memory grain directory
    //    keeps no replica, so those registrations are simply gone and the
    //    grains re-register on their next call.
    const lost = this.directory.dropPartition(address);
    if (lost.length > 0) {
      this.emit({
        type: 'directory-partition-lost',
        at: this.now,
        silo: address,
        entries: lost.length,
      });
    }

    // 4. Its own cache, and everything in transit to or from it.
    this.directory.clearCache(address);
    this.network.dropInvolving((message) => touchesSilo(message, address));

    // 5. Recompute ownership BEFORE gossiping, so silos reacting to the news
    //    resolve against the new ring rather than the old one.
    this.rebuildRing();

    // 6. Tell everyone still standing.
    for (const peer of this.activeSilos()) {
      this.send(
        {
          kind: 'membership-update',
          version: this.membership.version,
          changed: address,
          status: 'Dead',
        },
        { kind: 'townhall' },
        { kind: 'silo', silo: peer },
      );
    }
  }

  /**
   * Calls that will never be answered — usually because the silo holding the
   * grain crashed mid-request. Orleans surfaces this to the caller as a
   * timeout exception rather than hanging, and so do we.
   */
  private expireRequests(): void {
    const timeout = this.k.requestTimeout;
    for (const [requestId, request] of [...this.pending]) {
      if (this.now - request.startedAt < timeout) continue;
      this.pending.delete(requestId);
      this.stats.requestsTimedOut++;
      this.emit({
        type: 'request-timed-out',
        at: this.now,
        requestId,
        grainId: request.grainId,
      });
    }
  }

  /**
   * The common entry path for every kind of call — client, grain-to-grain,
   * reminder, stream delivery. Check the local cache, else ask the directory.
   */
  private routeRequest(requestId: RequestId, grainId: GrainId, entry: SiloAddress): void {
    const cached = this.directory.cacheGet(entry, grainId);
    if (cached) {
      this.stats.cacheHits++;
      this.emit({ type: 'cache-hit', at: this.now, silo: entry, grainId });
      this.sendGrainRequest(requestId, cached, entry);
      return;
    }
    this.stats.cacheMisses++;
    this.emit({ type: 'cache-miss', at: this.now, silo: entry, grainId });
    this.askDirectory(requestId, grainId, entry);
  }

  private askDirectory(requestId: RequestId, grainId: GrainId, from: SiloAddress): void {
    const owner = this.ring.ownerOf(grainId);
    if (!owner) return;
    this.send(
      { kind: 'dir-lookup', requestId, grainId, replyTo: from },
      { kind: 'silo', silo: from },
      { kind: 'directory', silo: owner },
    );
  }

  private placeAndCreate(requestId: RequestId, grainId: GrainId, requestingSilo: SiloAddress): void {
    const candidates = this.activeSilos();
    if (candidates.length === 0) return;

    const director = directorFor(this.placementStrategy);
    const target = director.pick({
      grainId,
      requestingSilo,
      candidates,
      activationCounts: this.activationCounts(),
      ring: this.ring,
      rng: this.placementRng,
    });
    if (!target) return;

    this.emit({
      type: 'placement-decided',
      at: this.now,
      grainId,
      target,
      strategy: director.id,
    });

    this.send(
      {
        kind: 'create-activation',
        requestId,
        grainId,
        activationId: `a${this.nextActivationId++}`,
        origin: requestingSilo,
      },
      { kind: 'silo', silo: requestingSilo },
      { kind: 'silo', silo: target },
    );
  }

  private onCreateActivation(
    requestId: RequestId,
    grainId: GrainId,
    activationId: string,
    host: SiloAddress,
    origin: SiloAddress,
  ): void {
    const silo = this.silos.get(host);
    if (!silo || silo.status !== 'Active') return;

    // A silo never builds the same grain twice. Two concurrent cold calls can
    // both reach placement and both pick this silo; without this check the
    // second activation would overwrite the first in the local map, orphaning
    // an activation that the directory may already be about to register.
    // Orleans serialises local activation per grain for exactly this reason.
    const existing = silo.activations.get(grainId);
    if (existing && !existing.isGone) {
      this.send(
        { kind: 'activation-ready', requestId, grainId, address: existing.address },
        { kind: 'silo', silo: host },
        { kind: 'silo', silo: origin },
      );
      return;
    }

    const address: GrainAddress = { grainId, activationId, silo: host };
    const activation = new Activation(address, grainTypeOf(grainId), this.now, origin);
    silo.activations.set(grainId, activation);
    this.emit({ type: 'activation-creating', at: this.now, address });

    const owner = this.ring.ownerOf(grainId);
    if (!owner) return;
    this.send(
      { kind: 'dir-register', requestId, candidate: address, replyTo: host },
      { kind: 'silo', silo: host },
      { kind: 'directory', silo: owner },
    );
  }

  private onRegisterReply(requestId: RequestId, candidate: GrainAddress, winner: GrainAddress): void {
    const silo = this.silos.get(candidate.silo);
    const activation = silo?.activations.get(candidate.grainId);

    if (winner.activationId === candidate.activationId) {
      if (activation && activation.address.activationId === candidate.activationId) {
        activation.state = 'Activating';
        this.emit({ type: 'activation-registered', at: this.now, address: candidate });

        if (activation.grainType.persistent) {
          // Reading state IS part of activation. Held open until the vault
          // answers, so a persistent grain visibly takes longer to come up.
          activation.activatingUntil = Number.POSITIVE_INFINITY;
          this.send(
            { kind: 'storage-read', requestId, address: candidate },
            { kind: 'activation', silo: candidate.silo, grainId: candidate.grainId },
            { kind: 'vault' },
          );
        } else {
          activation.activatingUntil = this.now + this.k.activationDuration;
        }

        // A ledger keeps its own durable reminder — registered on first
        // activation, and it survives everything that happens to the building.
        if (activation.grainType.name === 'ledger') {
          this.reminders.register(candidate.grainId, this.k.reminderPeriod, this.now);
        }
      }
    } else {
      // Lost the race. Orleans destroys the redundant activation and defers to
      // the winner — this is the single-activation guarantee doing its job.
      if (silo && activation && activation.address.activationId === candidate.activationId) {
        activation.state = 'Invalid';
        silo.activations.delete(candidate.grainId);
      }
      this.stats.registrationRacesLost++;
      this.emit({
        type: 'activation-ended',
        at: this.now,
        address: candidate,
        reason: 'lost-registration-race',
      });
    }

    // Either way, whoever asked for this activation needs the authoritative
    // address — including the loser, whose caller must now be pointed at the
    // winner rather than at the activation we just destroyed.
    const origin = activation?.requestedBy ?? candidate.silo;
    this.send(
      { kind: 'activation-ready', requestId, grainId: winner.grainId, address: winner },
      { kind: 'silo', silo: winner.silo },
      { kind: 'silo', silo: origin },
    );
  }

  private sendGrainRequest(requestId: RequestId, target: GrainAddress, origin: SiloAddress): void {
    const request = this.pending.get(requestId);
    this.send(
      {
        kind: 'grain-request',
        requestId,
        grainId: target.grainId,
        method: request?.method ?? 'Say',
        target,
        origin,
      },
      { kind: 'silo', silo: origin },
      { kind: 'activation', silo: target.silo, grainId: target.grainId },
    );
  }

  private onGrainRequest(
    requestId: RequestId,
    target: GrainAddress,
    method: string,
    origin: SiloAddress,
  ): void {
    const silo = this.silos.get(target.silo);
    const activation = silo?.activations.get(target.grainId);

    if (
      !silo ||
      silo.status !== 'Active' ||
      !activation ||
      activation.isGone ||
      activation.address.activationId !== target.activationId
    ) {
      // The caller's cache pointed at an activation that is no longer here.
      const reason = silo?.status === 'Active' ? 'activation-not-here' : 'silo-not-active';
      this.emit({ type: 'rejected', at: this.now, silo: target.silo, grainId: target.grainId, reason });
      this.send(
        { kind: 'rejection', requestId, grainId: target.grainId, reason, staleAddress: target },
        { kind: 'silo', silo: target.silo },
        { kind: 'silo', silo: origin },
      );
      return;
    }

    const depth = activation.enqueue({
      requestId,
      method,
      origin,
      enqueuedAt: this.now,
    });
    this.emit({
      type: 'request-enqueued',
      at: this.now,
      address: activation.address,
      requestId,
      queueDepth: depth,
    });
  }

  private onGrainResponse(requestId: RequestId, grainId: GrainId, to: NodeRef): void {
    if (to.kind === 'client') {
      this.completeRequest(requestId, grainId);
      return;
    }

    const request = this.pending.get(requestId);
    const at = this.siloOf(to);
    if (!request || !at) return;

    switch (request.origin.kind) {
      case 'client':
        // Back at the gateway: hand it to the client.
        this.send(
          { kind: 'grain-response', requestId, grainId },
          { kind: 'silo', silo: at },
          { kind: 'client', id: request.origin.clientId },
        );
        return;

      case 'grain': {
        // Back to the calling activation, which has been occupied this whole
        // time. Delivering this is what un-blocks its turn.
        const caller = request.origin.caller;
        this.completeRequest(requestId, grainId);
        this.send(
          { kind: 'grain-call-response', requestId, caller },
          { kind: 'silo', silo: at },
          { kind: 'activation', silo: caller.silo, grainId: caller.grainId },
        );
        return;
      }

      case 'reminder':
      case 'stream':
        // Nobody is waiting for an answer; the delivery itself was the point.
        this.completeRequest(requestId, grainId);
        if (request.origin.kind === 'stream') {
          this.stats.streamEventsDelivered++;
          this.emit({
            type: 'stream-delivered',
            at: this.now,
            streamId: request.origin.streamId,
            subscriber: grainId,
          });
        }
        return;
    }
  }

  private completeRequest(requestId: RequestId, grainId: GrainId): void {
    const request = this.pending.get(requestId);
    // Already timed out: the answer arrived after the caller gave up, so it is
    // discarded rather than counted as a success.
    if (!request) return;
    this.pending.delete(requestId);
    this.stats.requestsCompleted++;
    this.emit({
      type: 'request-completed',
      at: this.now,
      requestId,
      grainId,
      latency: this.now - request.startedAt,
    });
  }

  // -- activation lifecycle -------------------------------------------------

  private advanceActivationStates(): void {
    for (const silo of this.silos.values()) {
      for (const [grainId, activation] of [...silo.activations]) {
        if (
          activation.state === 'Activating' &&
          activation.activatingUntil !== undefined &&
          activation.activatingUntil <= this.now
        ) {
          activation.state = 'Valid';
          activation.activatingUntil = undefined;
          this.emit({ type: 'activation-valid', at: this.now, address: activation.address });
          continue;
        }

        if (
          activation.state === 'Deactivating' &&
          activation.deactivatingUntil !== undefined &&
          activation.deactivatingUntil <= this.now
        ) {
          this.finishDeactivation(silo.address, grainId, activation);
        }
      }
    }
  }

  /**
   * The last step of collection: unregister, then vanish. Order matters —
   * while the activation is Deactivating it is still registered, so a caller
   * that finds it in the directory gets a rejection rather than silence.
   */
  private finishDeactivation(
    siloAddress: SiloAddress,
    grainId: GrainId,
    activation: Activation,
  ): void {
    const silo = this.silos.get(siloAddress);
    activation.state = 'Invalid';
    silo?.activations.delete(grainId);

    this.stats.activationsCollected++;
    this.emit({
      type: 'activation-ended',
      at: this.now,
      address: activation.address,
      reason: 'collected',
    });

    const owner = this.ring.ownerOf(grainId);
    if (owner) {
      this.send(
        { kind: 'dir-unregister', address: activation.address },
        { kind: 'silo', silo: siloAddress },
        { kind: 'directory', silo: owner },
      );
    }
    this.directory.cacheInvalidateEverywhere(grainId);
  }

  private *allActivations(): Generator<Activation> {
    for (const silo of this.silos.values()) {
      for (const activation of silo.activations.values()) yield activation;
    }
  }

  private activationCounts(): Map<SiloAddress, number> {
    const counts = new Map<SiloAddress, number>();
    for (const silo of this.silos.values()) counts.set(silo.address, silo.activations.size);
    return counts;
  }

  // -- helpers --------------------------------------------------------------

  private siloOf(node: NodeRef): SiloAddress | undefined {
    switch (node.kind) {
      case 'silo':
      case 'directory':
      case 'activation':
      case 'pullingagent':
        return node.silo;
      default:
        return undefined;
    }
  }

  private send(envelope: Envelope, from: NodeRef, to: NodeRef): void {
    const message = this.network.send(envelope, from, to, this.now);
    this.emit({ type: 'message-sent', at: this.now, message });
  }

  private emit(event: SimEvent): void {
    this.events.emit(event);
  }

  // -- snapshot -------------------------------------------------------------

  snapshot(): SimState {
    const active = this.activeSilos();
    const votesRequired = this.membership.votesRequiredFor();

    const silos: SiloView[] = [...this.silos.values()].map((silo) => ({
      address: silo.address,
      status: silo.status,
      index: silo.index,
      ringPositions: this.ring.positionsFor(silo.address),
      activationCount: silo.activations.size,
      directoryEntryCount: this.directory.entryCount(silo.address),
      cacheEntryCount: this.directory.cacheCount(silo.address),
      iAmAliveAt: this.membership.row(silo.address)?.iAmAliveAt ?? 0,
      suspicionVotes: this.membership.freshVotes(
        silo.address,
        this.now,
        this.k.deathVoteExpiration,
      ).length,
      votesRequired,
      // The viewer is omniscient and the cluster is not: a crashed silo is
      // shown as gone immediately, while its status stays Active until the
      // protocol catches up. That gap is the thing worth watching.
      crashed: silo.crashed === true,
      probing:
        silo.status === 'Active' && !silo.crashed ? probeTargets(silo.address, active) : [],
    }));

    const activations: ActivationView[] = [];
    for (const activation of this.allActivations()) {
      activations.push({
        address: activation.address,
        state: activation.state,
        queueDepth: activation.inbox.length,
        executing: activation.executing,
        lastUsedAt: activation.lastUsedAt,
        turnsCompleted: activation.turnsCompleted,
        grainType: activation.grainType.name,
        reentrant: activation.grainType.reentrant,
        blockedOn: activation.blockedOn,
        collectible: isCollectible(activation, this.now, this.k.collectionAgeLimit),
        persistent: activation.grainType.persistent,
        storageVersion: activation.persistentState.version,
        storageWrites: activation.persistentState.writes,
        storageConflicts: activation.persistentState.conflicts,
      });
    }

    const inFlight: InFlightView[] = this.network.inFlight().map((message) => ({
      id: message.id,
      kind: message.envelope.kind,
      grainId: grainIdOf(message.envelope),
      from: message.from,
      to: message.to,
      progress: progressOf(message, this.now),
    }));

    return {
      now: this.now,
      silos,
      ring: this.ring.arcs(),
      activations,
      inFlight,
      stats: { ...this.stats } satisfies SimStats,
      reminders: this.reminders.all().map((r) => ({
        id: r.id,
        grainId: r.grainId,
        periodMs: r.periodMs,
        nextFireAt: r.nextFireAt,
        firedCount: r.firedCount,
      })),
      streams: this.streams.all().map((s) => ({
        id: s.id,
        producer: s.producer,
        subscribers: [...s.subscribers],
        published: s.published,
        delivered: s.delivered,
        agentSilo: StreamRegistry.agentFor(s.id, active),
      })),
      vault: {
        grainCount: this.storage.grainCount,
        totalVersions: this.storage.totalVersions,
        conflicts: this.storage.conflictCount,
        entries: this.storage.entries(),
      },
    };
  }
}

function grainIdOf(envelope: Envelope): GrainId | undefined {
  if ('grainId' in envelope) return envelope.grainId;
  if ('candidate' in envelope) return envelope.candidate.grainId;
  return undefined;
}

function touchesSilo(message: InFlight, silo: SiloAddress): boolean {
  const touches = (node: NodeRef): boolean =>
    (node.kind === 'silo' ||
      node.kind === 'directory' ||
      node.kind === 'activation' ||
      node.kind === 'pullingagent') &&
    node.silo === silo;
  return touches(message.from) || touches(message.to);
}

function freshStats() {
  return {
    requestsStarted: 0,
    requestsCompleted: 0,
    requestsTimedOut: 0,
    directoryHits: 0,
    directoryMisses: 0,
    cacheHits: 0,
    cacheMisses: 0,
    registrationRacesLost: 0,
    rejections: 0,
    probesSent: 0,
    probesMissed: 0,
    silosDeclaredDead: 0,
    activationsLostToFailure: 0,
    activationsCollected: 0,
    grainToGrainCalls: 0,
    deadlockedActivations: 0,
    storageReads: 0,
    storageWrites: 0,
    storageConflicts: 0,
    remindersFired: 0,
    streamEventsPublished: 0,
    streamEventsDelivered: 0,
  };
}
