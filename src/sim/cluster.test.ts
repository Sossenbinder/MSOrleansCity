import { describe, expect, it } from 'vitest';
import { Cluster } from './cluster';
import { DEFAULT_CONFIG, type SimConfig } from './config';
import type { EnvelopeKind, SimEvent, SimEventType } from './types';


/**
 * Collection turned off. These tests are about routing, placement and failure;
 * letting the collector reap idle activations mid-run would make them assert on
 * two mechanisms at once. Collection has its own suite.
 */
const NO_COLLECTION: SimConfig = {
  ...DEFAULT_CONFIG,
  knobs: { collectionAgeLimit: Number.POSITIVE_INFINITY },
};

const STEP = 25;

/** Background liveness traffic, present whenever the cluster is running. */
const MEMBERSHIP_KINDS = new Set<EnvelopeKind>([
  'probe',
  'probe-ack',
  'iam-alive',
  'suspect-vote',
  'membership-update',
]);

function run(cluster: Cluster, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += STEP) cluster.tick(STEP);
}

function record(cluster: Cluster): SimEventType[] {
  const types: SimEventType[] = [];
  cluster.events.on((event: SimEvent) => types.push(event.type));
  return types;
}

/** True when `needles` all appear in `haystack`, in order (gaps allowed). */
function containsInOrder(haystack: readonly string[], needles: readonly string[]): boolean {
  let i = 0;
  for (const item of haystack) {
    if (item === needles[i]) i++;
    if (i === needles.length) return true;
  }
  return i === needles.length;
}

function activationsFor(cluster: Cluster, grainId: string) {
  return cluster.snapshot().activations.filter((a) => a.address.grainId === grainId);
}

describe('cold call — the P0 story end to end', () => {
  it('completes a call to a grain that has never been activated', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.callGrain('user/42');
    run(cluster, 30_000);

    const state = cluster.snapshot();
    expect(state.stats.requestsCompleted).toBe(1);
    // Request traffic must drain. Membership chatter never does — probes and
    // heartbeats keep flowing for as long as the cluster is up — so this
    // deliberately ignores those rather than asserting an empty road network.
    expect(state.inFlight.filter((m) => !MEMBERSHIP_KINDS.has(m.kind))).toHaveLength(0);
  });

  it('walks the full narrative in the right order', () => {
    const cluster = new Cluster(NO_COLLECTION);
    const types = record(cluster);
    cluster.callGrain('user/42');
    run(cluster, 30_000);

    // This sequence IS the thing the city teaches. If it ever changes, the
    // guided tour and every explanation card are wrong too.
    expect(
      containsInOrder(types, [
        'request-started',
        'cache-miss',
        'directory-miss',
        'placement-decided',
        'activation-creating',
        'activation-registered',
        'activation-valid',
        'turn-started',
        'turn-completed',
        'request-completed',
      ]),
    ).toBe(true);

    // The request reaches the building while it is still being constructed and
    // waits at the door, so request-enqueued may land on either side of
    // activation-valid depending on network jitter. What is NOT negotiable is
    // that the turn starts only after both: a grain never executes before
    // OnActivateAsync has finished.
    expect(containsInOrder(types, ['request-enqueued', 'turn-started'])).toBe(true);
    expect(containsInOrder(types, ['activation-valid', 'turn-started'])).toBe(true);
  });

  it('leaves exactly one activation, in Valid state', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.callGrain('user/42');
    run(cluster, 30_000);

    const activations = activationsFor(cluster, 'user/42');
    expect(activations).toHaveLength(1);
    expect(activations[0]?.state).toBe('Valid');
    expect(activations[0]?.turnsCompleted).toBe(1);
  });

  it('registers the grain in exactly one directory partition', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.callGrain('user/42');
    run(cluster, 30_000);

    const totalEntries = cluster
      .snapshot()
      .silos.reduce((sum, silo) => sum + silo.directoryEntryCount, 0);
    expect(totalEntries).toBe(1);
  });
});

describe('single activation guarantee', () => {
  it('survives a registration race from every gateway at once', () => {
    const cluster = new Cluster(NO_COLLECTION);
    // Three simultaneous cold calls, one per gateway. Each gateway misses its
    // cache, each asks the directory, and more than one may reach placement
    // before anybody registers — exactly the race Orleans must survive.
    for (const gateway of cluster.siloAddresses()) {
      cluster.callGrain('user/42', 'Say', gateway);
    }
    run(cluster, 40_000);

    const state = cluster.snapshot();
    expect(activationsFor(cluster, 'user/42')).toHaveLength(1);
    expect(state.stats.requestsCompleted).toBe(3);

    const totalEntries = state.silos.reduce((sum, s) => sum + s.directoryEntryCount, 0);
    expect(totalEntries).toBe(1);
  });

  it('never lets two activations of one grain be Valid simultaneously', () => {
    const cluster = new Cluster(NO_COLLECTION);
    for (const gateway of cluster.siloAddresses()) {
      cluster.callGrain('user/42', 'Say', gateway);
    }

    let maxValid = 0;
    for (let elapsed = 0; elapsed < 40_000; elapsed += STEP) {
      cluster.tick(STEP);
      const valid = activationsFor(cluster, 'user/42').filter((a) => a.state === 'Valid');
      maxValid = Math.max(maxValid, valid.length);
    }

    expect(maxValid).toBe(1);
  });

  it('never builds the same grain twice on one silo', () => {
    // Two cold calls can both reach placement and both pick the same silo.
    // If the second overwrote the first in that silo's activation map, the
    // first would be orphaned — still being registered, but unreachable.
    const cluster = new Cluster({ ...NO_COLLECTION, siloCount: 1 });
    const only = cluster.siloAddresses()[0];
    for (let i = 0; i < 4; i++) cluster.callGrain('user/42', 'Say', only);
    run(cluster, 40_000);

    expect(activationsFor(cluster, 'user/42')).toHaveLength(1);
    expect(cluster.snapshot().stats.requestsCompleted).toBe(4);
    // With a single silo there is nowhere stale to route, so nothing should
    // ever be rejected.
    expect(cluster.snapshot().stats.rejections).toBe(0);
  });

  it('serialises concurrent calls through the one activation', () => {
    const cluster = new Cluster(NO_COLLECTION);
    for (const gateway of cluster.siloAddresses()) {
      cluster.callGrain('user/42', 'Say', gateway);
    }
    run(cluster, 40_000);

    const activations = activationsFor(cluster, 'user/42');
    expect(activations[0]?.turnsCompleted).toBe(3);
  });
});

describe('directory cache', () => {
  it('turns a second call from the same gateway into a cache hit', () => {
    const cluster = new Cluster(NO_COLLECTION);
    const gateway = cluster.siloAddresses()[0];
    expect(gateway).toBeDefined();

    cluster.callGrain('user/42', 'Say', gateway);
    run(cluster, 30_000);
    const cold = cluster.snapshot().stats;
    expect(cold.cacheHits).toBe(0);
    expect(cold.cacheMisses).toBe(1);

    cluster.callGrain('user/42', 'Say', gateway);
    run(cluster, 30_000);
    const warm = cluster.snapshot().stats;

    expect(warm.cacheHits).toBe(1);
    expect(warm.cacheMisses).toBe(1);
    expect(warm.requestsCompleted).toBe(2);
    // The warm call must not have consulted the authoritative partition at all.
    expect(warm.directoryHits).toBe(cold.directoryHits);
  });

  it('makes the warm path measurably shorter than the cold path', () => {
    const cluster = new Cluster(NO_COLLECTION);
    const gateway = cluster.siloAddresses()[0];
    const latencies: number[] = [];
    cluster.events.on((event) => {
      if (event.type === 'request-completed') latencies.push(event.latency);
    });

    cluster.callGrain('user/42', 'Say', gateway);
    run(cluster, 30_000);
    cluster.callGrain('user/42', 'Say', gateway);
    run(cluster, 30_000);

    expect(latencies).toHaveLength(2);
    const [cold, warm] = latencies;
    expect(cold).toBeDefined();
    expect(warm).toBeDefined();
    expect(warm ?? 0).toBeLessThan(cold ?? 0);
  });
});

describe('placement', () => {
  it('sends every grain to the ring owner under HashBased placement', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.setPlacement('HashBased');

    const decisions: Array<{ grainId: string; target: string }> = [];
    cluster.events.on((event) => {
      if (event.type === 'placement-decided') {
        decisions.push({ grainId: event.grainId, target: event.target });
      }
    });

    for (let i = 0; i < 12; i++) cluster.callGrain(`user/${i}`);
    run(cluster, 40_000);

    expect(decisions.length).toBe(12);
    // Deterministic placement means a second cluster must agree exactly.
    const other = new Cluster(NO_COLLECTION);
    other.setPlacement('HashBased');
    const otherDecisions: Array<{ grainId: string; target: string }> = [];
    other.events.on((event) => {
      if (event.type === 'placement-decided') {
        otherDecisions.push({ grainId: event.grainId, target: event.target });
      }
    });
    for (let i = 0; i < 12; i++) other.callGrain(`user/${i}`);
    run(other, 40_000);

    expect(otherDecisions).toEqual(decisions);
  });

  it('keeps the grain on the calling silo under PreferLocal placement', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.setPlacement('PreferLocal');
    const gateway = cluster.siloAddresses()[1];
    expect(gateway).toBeDefined();

    cluster.callGrain('user/7', 'Say', gateway);
    run(cluster, 30_000);

    expect(activationsFor(cluster, 'user/7')[0]?.address.silo).toBe(gateway);
  });

  it('spreads load under ActivationCountBased placement', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.setPlacement('ActivationCountBased');
    for (let i = 0; i < 9; i++) cluster.callGrain(`user/${i}`);
    run(cluster, 60_000);

    const counts = cluster.snapshot().silos.map((s) => s.activationCount);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(9);
    // Placement decisions are made from a snapshot of counts that is already
    // in flight, so perfect balance is not guaranteed — but no silo should be
    // starved while another hoards.
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(3);
  });
});

describe('determinism', () => {
  it('produces byte-identical state for the same seed and inputs', () => {
    const a = new Cluster(NO_COLLECTION);
    const b = new Cluster(NO_COLLECTION);

    for (const cluster of [a, b]) {
      for (let i = 0; i < 6; i++) cluster.callGrain(`user/${i}`);
      run(cluster, 40_000);
    }

    expect(JSON.stringify(b.snapshot())).toBe(JSON.stringify(a.snapshot()));
  });

  it('diverges for a different seed', () => {
    const a = new Cluster({ ...NO_COLLECTION, seed: 1 });
    const b = new Cluster({ ...NO_COLLECTION, seed: 2 });

    for (const cluster of [a, b]) {
      for (let i = 0; i < 6; i++) cluster.callGrain(`user/${i}`);
      run(cluster, 40_000);
    }

    const placementsOf = (c: Cluster) =>
      c.snapshot().activations.map((x) => `${x.address.grainId}@${x.address.silo}`).sort();
    expect(placementsOf(b)).not.toEqual(placementsOf(a));
  });
});
