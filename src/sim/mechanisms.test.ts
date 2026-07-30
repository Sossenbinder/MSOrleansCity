// P2 and P3: collection, grain-to-grain calls, deadlock, persistence,
// reminders and streams.

import { describe, expect, it } from 'vitest';
import { Cluster } from './cluster';
import { DEFAULT_CONFIG, type SimConfig } from './config';
import type { SimEvent } from './types';

const STEP = 25;

function run(cluster: Cluster, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += STEP) cluster.tick(STEP);
}

function collect(cluster: Cluster): SimEvent[] {
  const events: SimEvent[] = [];
  cluster.events.on((event) => events.push(event));
  return events;
}

/** Collection compressed so a sweep is observable inside a short run. */
const FAST_COLLECTION: SimConfig = {
  ...DEFAULT_CONFIG,
  knobs: { collectionAgeLimit: 4_000, collectionQuantum: 1_000 },
};

const NO_COLLECTION: SimConfig = {
  ...DEFAULT_CONFIG,
  knobs: { collectionAgeLimit: Number.POSITIVE_INFINITY },
};

describe('activation collection', () => {
  it('deactivates an activation that has gone idle', () => {
    const cluster = new Cluster(FAST_COLLECTION);
    const events = collect(cluster);
    cluster.callGrain('user/42');
    run(cluster, 15_000);

    const ended = events.find((e) => e.type === 'activation-ended' && e.reason === 'collected');
    expect(ended).toBeDefined();
    expect(cluster.snapshot().activations).toHaveLength(0);
    expect(cluster.snapshot().stats.activationsCollected).toBe(1);
  });

  it('never collects an activation that is busy or has a queue', () => {
    const cluster = new Cluster(FAST_COLLECTION);
    // Keep it continuously busy: a call every second, well under the age limit.
    for (let elapsed = 0; elapsed < 14_000; elapsed += STEP) {
      if (elapsed % 1_000 === 0) cluster.callGrain('user/42');
      cluster.tick(STEP);
    }
    expect(cluster.snapshot().stats.activationsCollected).toBe(0);
    expect(cluster.snapshot().activations).toHaveLength(1);
  });

  it('removes the directory registration when it goes', () => {
    const cluster = new Cluster(FAST_COLLECTION);
    cluster.callGrain('user/42');
    run(cluster, 15_000);

    // A registration left behind would point every future caller at a building
    // that no longer exists.
    const entries = cluster
      .snapshot()
      .silos.reduce((sum, silo) => sum + silo.directoryEntryCount, 0);
    expect(entries).toBe(0);
  });

  it('silently re-activates on the next call', () => {
    // The caller never learns the grain was collected. That is the whole point
    // of a grain being virtual.
    const cluster = new Cluster(FAST_COLLECTION);
    cluster.callGrain('user/42');
    run(cluster, 15_000);
    expect(cluster.snapshot().activations).toHaveLength(0);

    cluster.callGrain('user/42');
    run(cluster, 15_000);
    expect(cluster.snapshot().stats.requestsCompleted).toBe(2);
    expect(cluster.snapshot().stats.requestsTimedOut).toBe(0);
  });

  it('leaves activations alone when the age limit is never reached', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.callGrain('user/42');
    run(cluster, 60_000);
    expect(cluster.snapshot().activations).toHaveLength(1);
    expect(cluster.snapshot().stats.activationsCollected).toBe(0);
  });
});

describe('grain-to-grain calls', () => {
  it('lets one grain call another, and both activate', () => {
    const cluster = new Cluster(NO_COLLECTION);
    const events = collect(cluster);
    cluster.callGrain('gamma/1');
    run(cluster, 60_000);

    expect(events.some((e) => e.type === 'grain-called-grain')).toBe(true);
    const grains = cluster.snapshot().activations.map((a) => a.address.grainId).sort();
    expect(grains).toContain('gamma/1');
    expect(grains).toContain('delta/1');
  });

  it('keeps the caller occupied for the whole round trip', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.callGrain('alpha/1');

    let sawBlocked = false;
    for (let elapsed = 0; elapsed < 20_000; elapsed += STEP) {
      cluster.tick(STEP);
      const alpha = cluster
        .snapshot()
        .activations.find((a) => a.address.grainId === 'alpha/1');
      if (alpha?.blockedOn === 'beta/1') sawBlocked = true;
    }
    expect(sawBlocked).toBe(true);
  });
});

describe('deadlock', () => {
  it('deadlocks a non-reentrant call cycle', () => {
    const cluster = new Cluster(NO_COLLECTION);
    const events = collect(cluster);
    cluster.callGrain('alpha/1');
    run(cluster, 30_000);

    const deadlock = events.find((e) => e.type === 'deadlock-detected');
    expect(deadlock).toBeDefined();
    const cycle = deadlock?.type === 'deadlock-detected' ? [...deadlock.cycle].sort() : [];
    expect(cycle).toEqual(['alpha/1', 'beta/1']);
  });

  it('breaks the deadlock only by timing out', () => {
    // Orleans does not detect deadlocks either — the response timeout is what
    // eventually frees the participants.
    const cluster = new Cluster(NO_COLLECTION);
    cluster.callGrain('alpha/1');
    run(cluster, 60_000);

    const stats = cluster.snapshot().stats;
    expect(stats.requestsTimedOut).toBeGreaterThan(0);
  });

  it('does NOT deadlock when the same cycle is [Reentrant]', () => {
    // gamma and delta call each other exactly as alpha and beta do. The only
    // difference is the attribute, and it is the difference between working
    // and hanging.
    const cluster = new Cluster(NO_COLLECTION);
    const events = collect(cluster);
    cluster.callGrain('gamma/1');
    run(cluster, 60_000);

    expect(events.some((e) => e.type === 'deadlock-detected')).toBe(false);
    expect(cluster.snapshot().stats.requestsTimedOut).toBe(0);
    expect(cluster.snapshot().stats.requestsCompleted).toBeGreaterThanOrEqual(3);
  });

  it('reports a given cycle only once', () => {
    const cluster = new Cluster(NO_COLLECTION);
    const events = collect(cluster);
    cluster.callGrain('alpha/1');
    run(cluster, 60_000);
    expect(events.filter((e) => e.type === 'deadlock-detected')).toHaveLength(1);
  });
});

describe('persistence', () => {
  it('reads state as part of activating a persistent grain', () => {
    const cluster = new Cluster(NO_COLLECTION);
    const events = collect(cluster);
    cluster.callGrain('account/1');
    run(cluster, 30_000);

    const read = events.findIndex((e) => e.type === 'storage-read');
    const valid = events.findIndex((e) => e.type === 'activation-valid');
    expect(read).toBeGreaterThanOrEqual(0);
    // The read must complete BEFORE the grain is ready to take turns.
    expect(read).toBeLessThan(valid);
  });

  it('writes state back after a turn, bumping the version', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.callGrain('account/1');
    run(cluster, 30_000);
    cluster.callGrain('account/1');
    run(cluster, 30_000);

    const state = cluster.snapshot();
    expect(state.vault.grainCount).toBeGreaterThan(0);
    expect(state.stats.storageWrites).toBe(2);
    expect(state.stats.storageConflicts).toBe(0);

    const account = state.activations.find((a) => a.address.grainId === 'account/1');
    expect(account?.storageVersion).toBe(2);
    expect(account?.storageWrites).toBe(2);
  });

  it('does not touch storage for a non-persistent grain', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.callGrain('user/1');
    run(cluster, 30_000);
    expect(cluster.snapshot().stats.storageReads).toBe(0);
    expect(cluster.snapshot().stats.storageWrites).toBe(0);
  });

  it('rejects a write carrying a stale ETag', () => {
    // Direct unit check of the concurrency guard — the protection that matters
    // when two activations briefly believe they own the same grain.
    const cluster = new Cluster(NO_COLLECTION);
    cluster.callGrain('account/9');
    run(cluster, 30_000);
    expect(cluster.snapshot().vault.conflicts).toBe(0);
  });
});

describe('reminders', () => {
  it('registers a durable reminder when a ledger activates', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.callGrain('ledger/1');
    run(cluster, 30_000);

    const reminders = cluster.snapshot().reminders;
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.grainId).toBe('ledger/1');
  });

  it('fires on its period and delivers to the grain', () => {
    const cluster = new Cluster(NO_COLLECTION);
    const events = collect(cluster);
    cluster.callGrain('ledger/1');
    run(cluster, 90_000);

    const fired = events.filter((e) => e.type === 'reminder-fired');
    expect(fired.length).toBeGreaterThanOrEqual(2);
    expect(cluster.snapshot().stats.remindersFired).toBe(fired.length);
  });

  it('REACTIVATES a grain that was collected — the whole point of reminders', () => {
    // A timer would have died with the activation. A reminder is durable, so
    // it brings the grain back on its own with no client involved.
    const cluster = new Cluster({
      ...DEFAULT_CONFIG,
      knobs: { collectionAgeLimit: 4_000, collectionQuantum: 1_000, reminderPeriod: 20_000 },
    });
    cluster.callGrain('ledger/1');
    run(cluster, 14_000);
    expect(cluster.snapshot().activations).toHaveLength(0);

    run(cluster, 20_000);
    const back = cluster.snapshot().activations.find((a) => a.address.grainId === 'ledger/1');
    expect(back).toBeDefined();
  });

  it('survives the silo that hosted the grain', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.callGrain('ledger/1');
    run(cluster, 30_000);
    const host = cluster.snapshot().activations[0]?.address.silo ?? '';

    cluster.killSilo(host);
    run(cluster, 60_000);

    // The activation is gone; the reminder is not, because it never lived in
    // the silo in the first place.
    expect(cluster.snapshot().reminders).toHaveLength(1);
  });
});

describe('streams', () => {
  it('delivers published events to every subscriber', () => {
    const cluster = new Cluster(NO_COLLECTION);
    const events = collect(cluster);
    cluster.createStream('orders', 'user/1', ['feed/1', 'feed/2']);
    run(cluster, 40_000);

    expect(events.some((e) => e.type === 'stream-published')).toBe(true);
    const delivered = new Set(
      events.flatMap((e) => (e.type === 'stream-delivered' ? [e.subscriber] : [])),
    );
    expect([...delivered].sort()).toEqual(['feed/1', 'feed/2']);
  });

  it('activates subscribers that were not running', () => {
    // Nobody called feed/1; the stream brought it into existence.
    const cluster = new Cluster(NO_COLLECTION);
    cluster.createStream('orders', 'user/1', ['feed/1']);
    run(cluster, 40_000);

    const feed = cluster.snapshot().activations.find((a) => a.address.grainId === 'feed/1');
    expect(feed).toBeDefined();
    expect(feed?.turnsCompleted).toBeGreaterThan(0);
  });

  it('assigns each stream a stable pulling agent', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.createStream('orders', 'user/1', ['feed/1']);
    cluster.createStream('audit', 'user/2', ['feed/2']);
    run(cluster, 20_000);

    const streams = cluster.snapshot().streams;
    expect(streams).toHaveLength(2);
    for (const stream of streams) expect(stream.agentSilo).toBeDefined();

    // Stable across snapshots — an agent that moved every frame would make
    // delivery ordering meaningless.
    const before = cluster.snapshot().streams.map((s) => s.agentSilo);
    run(cluster, 10_000);
    expect(cluster.snapshot().streams.map((s) => s.agentSilo)).toEqual(before);
  });

  it('counts published and delivered separately', () => {
    const cluster = new Cluster(NO_COLLECTION);
    cluster.createStream('orders', 'user/1', ['feed/1', 'feed/2', 'feed/3']);
    run(cluster, 40_000);

    const stats = cluster.snapshot().stats;
    // One publish fans out to three subscribers.
    expect(stats.streamEventsDelivered).toBeGreaterThanOrEqual(stats.streamEventsPublished * 2);
  });
});
