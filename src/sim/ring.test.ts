import { describe, expect, it } from 'vitest';
import { ConsistentRing, type RingMember } from './ring';

const members: RingMember[] = [
  { address: 'silo-a', status: 'Active' },
  { address: 'silo-b', status: 'Active' },
  { address: 'silo-c', status: 'Active' },
];

function ringOf(m: RingMember[], buckets = 1): ConsistentRing {
  const ring = new ConsistentRing();
  ring.rebuild(m, buckets);
  return ring;
}

describe('ConsistentRing', () => {
  it('assigns every key to some owner', () => {
    const ring = ringOf(members);
    for (let i = 0; i < 500; i++) {
      expect(ring.ownerOf(`user/${i}`)).toBeDefined();
    }
  });

  it('is deterministic — the same key always lands on the same silo', () => {
    const a = ringOf(members);
    const b = ringOf([...members].reverse());
    for (let i = 0; i < 200; i++) {
      expect(a.ownerOf(`user/${i}`)).toBe(b.ownerOf(`user/${i}`));
    }
  });

  it('tiles the whole ring with no gaps', () => {
    const ring = ringOf(members, 4);
    const arcs = [...ring.arcs()].sort((x, y) => x.end - y.end);
    expect(arcs.length).toBe(12);

    // Each arc must start exactly where the previous one ended, and the last
    // must wrap to the first. A gap would mean orphaned grains.
    for (let i = 1; i < arcs.length; i++) {
      expect(arcs[i]?.start).toBeCloseTo(arcs[i - 1]?.end ?? -1, 12);
    }
    expect(arcs[0]?.start).toBeCloseTo(arcs[arcs.length - 1]?.end ?? -1, 12);
  });

  it('excludes silos that are not participating', () => {
    const ring = ringOf([
      { address: 'silo-a', status: 'Active' },
      { address: 'silo-b', status: 'Dead' },
    ]);
    const owners = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const owner = ring.ownerOf(`user/${i}`);
      if (owner) owners.add(owner);
    }
    expect([...owners]).toEqual(['silo-a']);
  });

  it('only disturbs keys near the departed silo when membership shrinks', () => {
    // The defining property of consistent hashing, and the reason Orleans can
    // lose a silo without reshuffling the entire directory.
    const before = ringOf(members, 8);
    const after = ringOf(
      members.map((m) => (m.address === 'silo-c' ? { ...m, status: 'Dead' as const } : m)),
      8,
    );

    const keys = Array.from({ length: 1000 }, (_, i) => `user/${i}`);
    const ownedByC = keys.filter((k) => before.ownerOf(k) === 'silo-c');
    const movedButNotOwnedByC = keys.filter(
      (k) => before.ownerOf(k) !== 'silo-c' && before.ownerOf(k) !== after.ownerOf(k),
    );

    expect(ownedByC.length).toBeGreaterThan(0);
    expect(movedButNotOwnedByC).toEqual([]);
  });

  it('reports an empty ring when nothing is up', () => {
    const ring = ringOf([{ address: 'silo-a', status: 'Dead' }]);
    expect(ring.isEmpty()).toBe(true);
    expect(ring.ownerOf('user/1')).toBeUndefined();
    expect(ring.arcs()).toEqual([]);
  });
});
