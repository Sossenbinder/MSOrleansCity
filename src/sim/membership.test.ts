import { describe, expect, it } from 'vitest';
import { requiredVotes } from './config';
import { MembershipTable, ProbeTracker, isAlive, probeTargets } from './membership';

const SILOS = ['silo-a', 'silo-b', 'silo-c', 'silo-d'];

describe('probe target selection', () => {
  it('watches a bounded number of peers, never itself', () => {
    for (const self of SILOS) {
      const targets = probeTargets(self, SILOS, 2);
      expect(targets).toHaveLength(2);
      expect(targets).not.toContain(self);
      expect(new Set(targets).size).toBe(2);
    }
  });

  it('leaves nobody unwatched', () => {
    // Ring-successor selection makes the watch graph a cycle, so every silo is
    // watched by at least one peer. A random subset would not guarantee this.
    const watched = new Set<string>();
    for (const self of SILOS) for (const t of probeTargets(self, SILOS, 1)) watched.add(t);
    expect(watched.size).toBe(SILOS.length);
  });

  it('is stable — the same membership yields the same assignment', () => {
    expect(probeTargets('silo-a', SILOS, 2)).toEqual(
      probeTargets('silo-a', [...SILOS].reverse(), 2),
    );
  });

  it('cannot ask for more targets than there are peers', () => {
    expect(probeTargets('silo-a', ['silo-a', 'silo-b'], 3)).toEqual(['silo-b']);
    expect(probeTargets('silo-a', ['silo-a'], 3)).toEqual([]);
    expect(probeTargets('silo-a', [], 3)).toEqual([]);
  });
});

describe('ProbeTracker', () => {
  it('counts consecutive misses', () => {
    const tracker = new ProbeTracker();
    for (let round = 1; round <= 3; round++) {
      tracker.issue('a', 'b', round * 100);
      const expired = tracker.collectExpired(round * 100);
      expect(expired[0]?.consecutive).toBe(round);
    }
    expect(tracker.missesFor('a', 'b')).toBe(3);
  });

  it('resets the counter when a ping is answered', () => {
    // Misses must be CONSECUTIVE: ordinary packet loss over hours must never
    // accumulate into an eviction.
    const tracker = new ProbeTracker();
    tracker.issue('a', 'b', 100);
    tracker.collectExpired(100);
    expect(tracker.missesFor('a', 'b')).toBe(1);

    const id = tracker.issue('a', 'b', 200);
    expect(tracker.acknowledge(id)).toBe(true);
    expect(tracker.missesFor('a', 'b')).toBe(0);
  });

  it('keeps miss counts separate per watcher/target pair', () => {
    const tracker = new ProbeTracker();
    tracker.issue('a', 'c', 100);
    tracker.issue('b', 'c', 100);
    tracker.collectExpired(100);

    tracker.issue('a', 'c', 200);
    tracker.collectExpired(200);

    expect(tracker.missesFor('a', 'c')).toBe(2);
    expect(tracker.missesFor('b', 'c')).toBe(1);
  });

  it('does not expire a probe before its deadline', () => {
    const tracker = new ProbeTracker();
    tracker.issue('a', 'b', 500);
    expect(tracker.collectExpired(499)).toEqual([]);
    expect(tracker.hasOutstanding('a', 'b')).toBe(true);
  });

  it('forgets everything about a silo once it is gone', () => {
    const tracker = new ProbeTracker();
    tracker.issue('a', 'b', 100);
    tracker.collectExpired(100);
    tracker.forget('b');
    expect(tracker.missesFor('a', 'b')).toBe(0);
    expect(tracker.hasOutstanding('a', 'b')).toBe(false);
  });
});

describe('MembershipTable', () => {
  function seeded(): MembershipTable {
    const table = new MembershipTable();
    table.seed(['a', 'b', 'c'], 0);
    return table;
  }

  it('starts everyone Active', () => {
    const table = seeded();
    expect(table.activeAddresses().sort()).toEqual(['a', 'b', 'c']);
    expect(table.all().every((r) => isAlive(r.status))).toBe(true);
  });

  it('bumps its version only on real status changes', () => {
    const table = seeded();
    const before = table.version;
    expect(table.setStatus('a', 'Active')).toBeUndefined();
    expect(table.version).toBe(before);

    expect(table.setStatus('a', 'Dead')).toBe('Active');
    expect(table.version).toBe(before + 1);
  });

  it('counts one vote per voter, however often they vote', () => {
    const table = seeded();
    table.addSuspicion('c', 'a', 0);
    table.addSuspicion('c', 'a', 10);
    table.addSuspicion('c', 'a', 20);
    expect(table.freshVotes('c', 20, 1000)).toEqual(['a']);
  });

  it('expires stale votes so old blips cannot accumulate', () => {
    const table = seeded();
    table.addSuspicion('c', 'a', 0);
    table.addSuspicion('c', 'b', 900);

    expect(table.freshVotes('c', 950, 1000)).toHaveLength(2);
    // 'a' voted at 0; by t=1500 with a 1000ms window it no longer counts.
    expect(table.freshVotes('c', 1500, 1000)).toEqual(['b']);
  });

  it('prunes without being asked to read', () => {
    const table = seeded();
    table.addSuspicion('c', 'a', 0);
    table.pruneVotes(5000, 1000);
    expect(table.freshVotes('c', 5000, 1_000_000)).toEqual([]);
  });

  it('clears a dead silo’s own accusations', () => {
    const table = seeded();
    table.addSuspicion('c', 'a', 0);
    table.setStatus('c', 'Dead');
    expect(table.freshVotes('c', 0, 1000)).toEqual([]);
  });

  it('ignores votes against an already-dead silo', () => {
    const table = seeded();
    table.setStatus('c', 'Dead');
    table.addSuspicion('c', 'a', 0);
    expect(table.freshVotes('c', 0, 1000)).toEqual([]);
  });

  it('stops counting a dead silo as active', () => {
    const table = seeded();
    table.setStatus('b', 'Dead');
    expect(table.activeAddresses().sort()).toEqual(['a', 'c']);
    expect(table.activeCount()).toBe(2);
  });
});

describe('vote quorum', () => {
  it('needs agreement from more than one silo when the cluster allows it', () => {
    expect(requiredVotes(5)).toBe(2);
    expect(requiredVotes(3)).toBe(2);
  });

  it('never demands more votes than there are silos to cast them', () => {
    // Two silos, one suspect: only one peer can possibly vote. Demanding two
    // would make failure undetectable in a two-silo cluster.
    expect(requiredVotes(2)).toBe(1);
    expect(requiredVotes(1)).toBe(1);
  });
});
