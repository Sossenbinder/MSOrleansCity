// Tunable knobs, and the honesty rule that governs them.
//
// ACCURACY DISCIPLINE (outline: Approach -> Accuracy discipline, and the
// first Open Question). Every knob here separates two different numbers:
//
//   simulatedMs    what the simulation actually uses. Chosen for watchability
//                  — a probe cycle you can follow with your eyes. This is our
//                  number and we are free to pick it.
//
//   orleansDefault what a real Orleans cluster uses by default. This MUST be
//                  read from the Orleans source or docs and cited before it is
//                  filled in. It is `null` everywhere below because it has not
//                  been verified yet, and a wrong default in a teaching tool is
//                  worse than an absent one. Do not populate these from memory.
//
// The inspector renders both, so nobody mistakes our pacing for Orleans'
// pacing (outline: Trade-offs -> "Slowed timescales distort intuition").

export interface Knob {
  readonly id: string;
  readonly label: string;
  /** Fully-qualified Orleans options property that governs this in reality. */
  readonly optionsClass: string;
  /** What the simulation uses, in simulated milliseconds. */
  readonly simulatedMs: number;
  /**
   * The real Orleans default. `null` until verified against the Orleans
   * source, at which point `sourceRef` must cite where it was read.
   */
  readonly orleansDefault: { readonly valueMs: number; readonly sourceRef: string } | null;
  readonly description: string;
}

function knob(k: Knob): Knob {
  return k;
}

export const KNOBS = {
  networkHop: knob({
    id: 'networkHop',
    label: 'Network hop',
    optionsClass: '(physical network latency — not an Orleans option)',
    simulatedMs: 600,
    orleansDefault: null,
    description:
      'Time a message spends travelling between two nodes. Slowed dramatically so ' +
      'each hop of a grain call is individually visible as a vehicle on a road.',
  }),

  activationDuration: knob({
    id: 'activationDuration',
    label: 'OnActivateAsync duration',
    optionsClass: 'Grain.OnActivateAsync',
    simulatedMs: 1200,
    orleansDefault: null,
    description:
      'How long a grain takes to activate before it can accept its first turn. ' +
      'In reality this is entirely your code — loading state, warming caches.',
  }),

  turnDuration: knob({
    id: 'turnDuration',
    label: 'Request turn duration',
    optionsClass: '(your grain method body)',
    simulatedMs: 900,
    orleansDefault: null,
    description:
      'How long one request occupies the activation. Because grains are ' +
      'single-threaded, this is exactly how long every other caller waits.',
  }),

  requestTimeout: knob({
    id: 'requestTimeout',
    label: 'Request timeout',
    optionsClass: 'SiloMessagingOptions.ResponseTimeout',
    simulatedMs: 30_000,
    orleansDefault: null,
    description:
      'How long a caller waits for a response before giving up. This is what ' +
      'surfaces a silo failure to the caller as an exception rather than a hang, ' +
      'and what eventually breaks a non-reentrant deadlock. Kept well above the ' +
      'cost of a cold activation on purpose: a legitimate chain of grain calls, ' +
      'each activating on demand, must not be mistaken for a hang.',
  }),

  probeInterval: knob({
    id: 'probeInterval',
    label: 'Probe interval',
    optionsClass: 'ClusterMembershipOptions.ProbeTimeout',
    simulatedMs: 3_000,
    orleansDefault: null,
    description:
      'How often each silo pings the peers it is responsible for watching. ' +
      'Nobody watches everybody — each silo watches a handful of ring neighbours, ' +
      'so detection cost stays flat as the cluster grows.',
  }),

  probeTimeout: knob({
    id: 'probeTimeout',
    label: 'Probe timeout',
    optionsClass: 'ClusterMembershipOptions.ProbeTimeout',
    simulatedMs: 2_200,
    orleansDefault: null,
    description: 'How long a ping may go unanswered before it counts as missed.',
  }),

  iAmAlivePublish: knob({
    id: 'iAmAlivePublish',
    label: 'IAmAlive publish interval',
    optionsClass: 'ClusterMembershipOptions.IAmAliveTablePublishTimeout',
    simulatedMs: 6_000,
    orleansDefault: null,
    description:
      'How often a silo stamps its own row in the membership table to say it is ' +
      'still running. A separate signal from probing: probes are peer-to-peer, ' +
      'this is written to shared storage.',
  }),

  deathVoteExpiration: knob({
    id: 'deathVoteExpiration',
    label: 'Death vote expiration',
    optionsClass: 'ClusterMembershipOptions.DeathVoteExpirationTimeout',
    simulatedMs: 25_000,
    orleansDefault: null,
    description:
      'How long a suspicion vote stays valid. Votes expire so that a silo which ' +
      'was briefly unreachable does not accumulate votes forever and get ' +
      'declared dead long after it recovered.',
  }),

  collectionAgeLimit: knob({
    id: 'collectionAgeLimit',
    label: 'Collection age limit',
    optionsClass: 'GrainCollectionOptions.CollectionAge',
    simulatedMs: 20_000,
    orleansDefault: null,
    description:
      'How long an activation may sit idle before the collector deactivates it. ' +
      'The reason a grain is "virtual": it exists conceptually forever, but is ' +
      'only materialised while it is being used.',
  }),

  collectionQuantum: knob({
    id: 'collectionQuantum',
    label: 'Collection quantum',
    optionsClass: 'GrainCollectionOptions.CollectionQuantum',
    simulatedMs: 5_000,
    orleansDefault: null,
    description: 'How often the collector wakes up and sweeps for idle activations.',
  }),

  deactivationDuration: knob({
    id: 'deactivationDuration',
    label: 'OnDeactivateAsync duration',
    optionsClass: 'Grain.OnDeactivateAsync',
    simulatedMs: 900,
    orleansDefault: null,
    description:
      'How long a grain takes to shut down. It accepts no new turns during this ' +
      'window, and only unregisters from the directory once it is finished.',
  }),

  storageLatency: knob({
    id: 'storageLatency',
    label: 'Storage round trip',
    optionsClass: 'IGrainStorage (Azure / ADO.NET / Redis ...)',
    simulatedMs: 1_100,
    orleansDefault: null,
    description:
      'Time to read or write grain state. Entirely provider-dependent in reality — ' +
      'this is a stand-in so the trip to the vault is visible.',
  }),

  reminderPeriod: knob({
    id: 'reminderPeriod',
    label: 'Reminder period',
    optionsClass: 'IGrainReminder · RegisterOrUpdateReminder(period)',
    simulatedMs: 18_000,
    orleansDefault: null,
    description:
      'How often a registered reminder fires. Reminders are durable and survive ' +
      'both deactivation and silo failure — unlike timers, which are in-memory ' +
      'and die with their activation.',
  }),

  streamPublishInterval: knob({
    id: 'streamPublishInterval',
    label: 'Stream publish interval',
    optionsClass: '(your producer)',
    simulatedMs: 4_500,
    orleansDefault: null,
    description: 'How often the demo producer pushes an event onto its stream.',
  }),
} as const satisfies Record<string, Knob>;

export type KnobId = keyof typeof KNOBS;

/**
 * Settings that are counts rather than durations. Same honesty rule applies:
 * `simulated` is ours, `orleansDefault` stays null until read from source.
 *
 * These are behavioural, not cosmetic — changing the vote threshold changes
 * whether a silo gets declared dead at all — which is exactly why they must
 * not be quietly presented as Orleans' values.
 */
export interface CountKnob {
  readonly id: string;
  readonly label: string;
  readonly optionsClass: string;
  readonly simulated: number;
  readonly orleansDefault: { readonly value: number; readonly sourceRef: string } | null;
  readonly description: string;
}

function count(k: CountKnob): CountKnob {
  return k;
}

export const COUNTS = {
  numProbedSilos: count({
    id: 'numProbedSilos',
    label: 'Silos probed per silo',
    optionsClass: 'ClusterMembershipOptions.NumProbedSilos',
    simulated: 2,
    orleansDefault: null,
    description:
      'How many ring neighbours each silo watches. Bounded on purpose: an ' +
      'all-watch-all cluster would generate probe traffic proportional to the ' +
      'square of its size.',
  }),

  numMissedProbesLimit: count({
    id: 'numMissedProbesLimit',
    label: 'Missed probes before suspecting',
    optionsClass: 'ClusterMembershipOptions.NumMissedProbesLimit',
    simulated: 3,
    orleansDefault: null,
    description:
      'Consecutive unanswered pings before a watcher files a suspicion vote. ' +
      'Greater than one so a single dropped packet or GC pause does not evict a ' +
      'perfectly healthy silo.',
  }),

  numVotesForDeathDeclaration: count({
    id: 'numVotesForDeathDeclaration',
    label: 'Votes to declare dead',
    optionsClass: 'ClusterMembershipOptions.NumVotesForDeathDeclaration',
    simulated: 2,
    orleansDefault: null,
    description:
      'Independent silos that must agree before a peer is declared dead. This is ' +
      'what stops one silo with a broken network card from evicting the rest of ' +
      'the cluster one by one.',
  }),
} as const satisfies Record<string, CountKnob>;

export type Setting = Knob | CountKnob;

export function isTimeKnob(setting: Setting): setting is Knob {
  return 'simulatedMs' in setting;
}

export function allSettings(): Setting[] {
  return [...Object.values(KNOBS), ...Object.values(COUNTS)];
}

/** Every setting whose real-world default still needs verifying against source. */
export function unverifiedSettings(): Setting[] {
  return allSettings().filter((s) => s.orleansDefault === null);
}

/**
 * How many votes are actually required right now.
 *
 * A three-silo cluster cannot produce two independent votes against a silo if
 * only one peer remains to vote, so the requirement is capped by the number of
 * potential voters. Orleans makes a similar small-cluster accommodation; the
 * exact rule is unverified, so this is our approximation, not a transcription.
 */
export function requiredVotes(activeSiloCount: number): number {
  const potentialVoters = Math.max(1, activeSiloCount - 1);
  return Math.max(1, Math.min(COUNTS.numVotesForDeathDeclaration.simulated, potentialVoters));
}

/**
 * Per-run overrides for any timing knob, in simulated milliseconds.
 *
 * Needed for two reasons. Scenarios want to compress or stretch a mechanism to
 * make it watchable — a collection demo is tedious at the default age limit.
 * And tests want to isolate: a test about placement should not also be a test
 * about the collector, so it turns collection off rather than racing it.
 */
export type KnobOverrides = Partial<Record<KnobId, number>>;

export function resolveKnobs(overrides: KnobOverrides = {}): Record<KnobId, number> {
  const resolved = {} as Record<KnobId, number>;
  for (const [id, knob] of Object.entries(KNOBS)) {
    const key = id as KnobId;
    resolved[key] = overrides[key] ?? knob.simulatedMs;
  }
  return resolved;
}

export interface SimConfig {
  readonly seed: number;
  readonly siloCount: number;
  readonly knobs?: KnobOverrides;
  /**
   * Ring positions per silo. Orleans' ConsistentRingProvider supports virtual
   * buckets, and they exist for a reason that is visible here: with a single
   * position each, hashing hands two silos most of the ring and leaves the
   * rest with slivers. Three positions per silo spreads ownership without
   * making the arcs too small to point at.
   *
   * ACCURACY: the real default bucket count is unverified — see the rule at
   * the top of this file. Do not label 3 as "the Orleans default".
   */
  readonly virtualBucketsPerSilo: number;
  /** Multiplies every duration in KNOBS. Driven by the speed control. */
  readonly timeScale: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 1337,
  siloCount: 3,
  virtualBucketsPerSilo: 3,
  timeScale: 1,
};
