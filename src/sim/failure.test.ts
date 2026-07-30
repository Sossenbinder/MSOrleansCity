// The P1 story: a silo crashes, the cluster works it out on its own, and the
// grains it hosted come back somewhere else.

import { describe, expect, it } from 'vitest';
import { Cluster } from './cluster';
import { DEFAULT_CONFIG, KNOBS, type SimConfig } from './config';
import type { SimEvent, SimEventType } from './types';


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

function run(cluster: Cluster, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += STEP) cluster.tick(STEP);
}

function collect(cluster: Cluster): SimEvent[] {
  const events: SimEvent[] = [];
  cluster.events.on((event) => events.push(event));
  return events;
}

function typesOf(events: SimEvent[]): SimEventType[] {
  return events.map((e) => e.type);
}

/** Settles a cold call so there is a real activation to lose. */
function warmed(grainId = 'user/42'): { cluster: Cluster; host: string } {
  const cluster = new Cluster(NO_COLLECTION);
  cluster.callGrain(grainId);
  run(cluster, 20_000);
  const host = cluster.snapshot().activations[0]?.address.silo;
  if (!host) throw new Error('setup failed: no activation was created');
  return { cluster, host };
}

describe('failure detection', () => {
  it('declares a crashed silo dead without anyone being told', () => {
    const { cluster, host } = warmed();
    const events = collect(cluster);

    expect(cluster.killSilo(host)).toBe(true);
    run(cluster, 60_000);

    const dead = events.find((e) => e.type === 'silo-declared-dead');
    expect(dead).toBeDefined();
    expect(dead?.type === 'silo-declared-dead' && dead.silo).toBe(host);
    expect(cluster.snapshot().silos.find((s) => s.address === host)?.status).toBe('Dead');
  });

  it('reaches that conclusion through misses, then votes, in that order', () => {
    const { cluster, host } = warmed();
    const events = collect(cluster);
    cluster.killSilo(host);
    run(cluster, 60_000);

    const order = typesOf(events).filter(
      (t) => t === 'probe-missed' || t === 'suspicion-voted' || t === 'silo-declared-dead',
    );
    expect(order[0]).toBe('probe-missed');
    expect(order).toContain('suspicion-voted');
    expect(order[order.length - 1]).toBe('silo-declared-dead');
  });

  it('requires several consecutive misses before anyone votes', () => {
    const { cluster, host } = warmed();
    const events = collect(cluster);
    cluster.killSilo(host);
    run(cluster, 60_000);

    const firstVote = events.findIndex((e) => e.type === 'suspicion-voted');
    const missesBefore = events
      .slice(0, firstVote)
      .filter((e) => e.type === 'probe-missed' && e.target === host);

    expect(missesBefore.length).toBeGreaterThanOrEqual(3);
  });

  it('needs agreement from more than one watcher', () => {
    const { cluster, host } = warmed();
    const events = collect(cluster);
    cluster.killSilo(host);
    run(cluster, 60_000);

    const voters = new Set(
      events.flatMap((e) => (e.type === 'suspicion-voted' && e.suspect === host ? [e.voter] : [])),
    );
    expect(voters.size).toBeGreaterThanOrEqual(2);
    expect(voters.has(host)).toBe(false);
  });

  it('leaves healthy silos alone indefinitely', () => {
    const cluster = new Cluster(NO_COLLECTION);
    const events = collect(cluster);
    for (let i = 0; i < 5; i++) cluster.callGrain(`user/${i}`);
    run(cluster, 120_000);

    expect(events.filter((e) => e.type === 'suspicion-voted')).toEqual([]);
    expect(cluster.snapshot().silos.every((s) => s.status === 'Active')).toBe(true);
    // Probing must actually have been happening, or this proves nothing.
    expect(cluster.snapshot().stats.probesSent).toBeGreaterThan(10);
  });

  it('answers probes while healthy, so misses stay at zero', () => {
    const cluster = new Cluster(NO_COLLECTION);
    run(cluster, 60_000);
    const stats = cluster.snapshot().stats;
    expect(stats.probesSent).toBeGreaterThan(0);
    expect(stats.probesMissed).toBe(0);
  });
});

describe('what a silo takes with it', () => {
  it('destroys the activations it was hosting', () => {
    const { cluster, host } = warmed();
    const events = collect(cluster);
    expect(cluster.snapshot().activations).toHaveLength(1);

    cluster.killSilo(host);
    run(cluster, 60_000);

    const ended = events.find(
      (e) => e.type === 'activation-ended' && e.reason === 'silo-died',
    );
    expect(ended).toBeDefined();
    expect(cluster.snapshot().activations).toHaveLength(0);
    expect(cluster.snapshot().stats.activationsLostToFailure).toBe(1);
  });

  it('drops the directory partition it owned', () => {
    const cluster = new Cluster(NO_COLLECTION);
    for (let i = 0; i < 12; i++) cluster.callGrain(`user/${i}`);
    run(cluster, 60_000);

    // Pick a silo that actually owns directory entries, or the test is vacuous.
    const owner = cluster.snapshot().silos.find((s) => s.directoryEntryCount > 0);
    expect(owner).toBeDefined();

    const events = collect(cluster);
    cluster.killSilo(owner?.address ?? '');
    run(cluster, 60_000);

    const lost = events.find((e) => e.type === 'directory-partition-lost');
    expect(lost).toBeDefined();
    expect(lost?.type === 'directory-partition-lost' && lost.entries).toBeGreaterThan(0);
  });

  it('leaves no registration anywhere pointing at the dead silo', () => {
    const cluster = new Cluster(NO_COLLECTION);
    for (let i = 0; i < 12; i++) cluster.callGrain(`user/${i}`);
    run(cluster, 60_000);

    const victim = cluster.snapshot().silos.find((s) => s.activationCount > 0)?.address;
    expect(victim).toBeDefined();

    cluster.killSilo(victim ?? '');
    run(cluster, 60_000);

    // A stale registration would send every future caller into a black hole.
    for (const activation of cluster.snapshot().activations) {
      expect(activation.address.silo).not.toBe(victim);
    }
  });

  it('rebuilds the ring so the survivors cover it completely', () => {
    const { cluster, host } = warmed();
    cluster.killSilo(host);
    run(cluster, 60_000);

    const state = cluster.snapshot();
    expect(state.ring.every((arc) => arc.silo !== host)).toBe(true);

    const arcs = [...state.ring].sort((a, b) => a.end - b.end);
    for (let i = 1; i < arcs.length; i++) {
      expect(arcs[i]?.start).toBeCloseTo(arcs[i - 1]?.end ?? -1, 12);
    }
  });
});

describe('recovery', () => {
  it('re-activates a lost grain on a surviving silo when it is next called', () => {
    // The whole promise of the virtual actor model: the caller does nothing
    // special, and the grain is simply there again.
    const { cluster, host } = warmed('user/42');
    cluster.killSilo(host);
    run(cluster, 60_000);
    expect(cluster.snapshot().activations).toHaveLength(0);

    const before = cluster.snapshot().stats.requestsCompleted;
    cluster.callGrain('user/42');
    run(cluster, 40_000);

    const state = cluster.snapshot();
    expect(state.stats.requestsCompleted).toBe(before + 1);
    expect(state.activations).toHaveLength(1);
    expect(state.activations[0]?.address.silo).not.toBe(host);
  });

  it('gives the re-activated grain a brand new activation id', () => {
    // Nothing is recovered. Orleans does not checkpoint grain state for you;
    // the new activation starts from scratch.
    const { cluster, host } = warmed('user/42');
    const original = cluster.snapshot().activations[0]?.address.activationId;

    cluster.killSilo(host);
    run(cluster, 60_000);
    cluster.callGrain('user/42');
    run(cluster, 40_000);

    expect(cluster.snapshot().activations[0]?.address.activationId).not.toBe(original);
  });

  it('keeps serving grains that were never on the dead silo', () => {
    const cluster = new Cluster(NO_COLLECTION);
    for (let i = 0; i < 9; i++) cluster.callGrain(`user/${i}`);
    run(cluster, 60_000);

    const victim = cluster.snapshot().silos.find((s) => s.activationCount > 0)?.address;
    const survivors = cluster
      .snapshot()
      .activations.filter((a) => a.address.silo !== victim)
      .map((a) => a.address.grainId);

    cluster.killSilo(victim ?? '');
    run(cluster, 60_000);

    const stillStanding = cluster.snapshot().activations.map((a) => a.address.grainId);
    for (const grainId of survivors) expect(stillStanding).toContain(grainId);
  });

  it('routes new calls only to silos that are still up', () => {
    const { cluster, host } = warmed();
    cluster.killSilo(host);
    run(cluster, 60_000);

    for (let i = 0; i < 8; i++) cluster.callGrain(`order/${i}`);
    run(cluster, 60_000);

    const state = cluster.snapshot();
    expect(state.activations.every((a) => a.address.silo !== host)).toBe(true);
    expect(state.stats.requestsCompleted).toBeGreaterThanOrEqual(8);
  });
});

describe('calls caught in the failure', () => {
  it('times out a request whose host vanished mid-flight', () => {
    const { cluster, host } = warmed('user/42');
    const events = collect(cluster);

    // Call the grain, then kill its host before the answer can come back.
    cluster.callGrain('user/42');
    run(cluster, 600);
    cluster.killSilo(host);
    run(cluster, KNOBS.requestTimeout.simulatedMs + 20_000);

    expect(events.some((e) => e.type === 'request-timed-out')).toBe(true);
    expect(cluster.snapshot().stats.requestsTimedOut).toBeGreaterThan(0);
  });

  it('does not count a timed-out request as completed', () => {
    const { cluster, host } = warmed('user/42');
    const completedBefore = cluster.snapshot().stats.requestsCompleted;

    cluster.callGrain('user/42');
    run(cluster, 600);
    cluster.killSilo(host);
    run(cluster, KNOBS.requestTimeout.simulatedMs + 40_000);

    const stats = cluster.snapshot().stats;
    expect(stats.requestsCompleted).toBe(completedBefore);
    expect(stats.requestsStarted).toBe(stats.requestsCompleted + stats.requestsTimedOut);
  });

  it('cannot be killed twice', () => {
    const { cluster, host } = warmed();
    expect(cluster.killSilo(host)).toBe(true);
    run(cluster, 60_000);
    expect(cluster.killSilo(host)).toBe(false);
  });
});
