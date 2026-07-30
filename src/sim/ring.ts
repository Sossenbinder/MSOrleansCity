// The consistent hash ring — the ring road encircling the city.
//
// Orleans partitions the grain directory across silos with a consistent hash
// ring (ConsistentRingProvider). Each silo takes one or more positions on the
// ring; a grain hashes to a position, and the directory partition that owns it
// is the silo at the next position clockwise. That is the whole mechanism, and
// it is why adding or losing a silo only disturbs the arcs adjacent to it
// rather than reshuffling every grain in the cluster.
//
// See hash.ts for why our ring positions are not bit-identical to Orleans'.

import { ringPosition } from './hash';
import type { RingArc, SiloAddress, SiloStatus } from './types';

export interface RingBucket {
  readonly silo: SiloAddress;
  /** Position on a 0..1 ring. */
  readonly position: number;
}

export interface RingMember {
  readonly address: SiloAddress;
  readonly status: SiloStatus;
}

/**
 * Only silos that are actually up participate. When P1 kills a silo, dropping
 * it from this list is what triggers arc handoff — the ring has no separate
 * "remove" path, it is always rebuilt from current membership.
 */
function participates(status: SiloStatus): boolean {
  return status === 'Active' || status === 'ShuttingDown';
}

export class ConsistentRing {
  /** Sorted ascending by position. */
  private buckets: RingBucket[] = [];

  rebuild(members: readonly RingMember[], bucketsPerSilo: number): void {
    const next: RingBucket[] = [];
    for (const member of members) {
      if (!participates(member.status)) continue;
      for (let i = 0; i < Math.max(1, bucketsPerSilo); i++) {
        next.push({
          silo: member.address,
          position: ringPosition(`${member.address}#${i}`),
        });
      }
    }
    next.sort((a, b) => a.position - b.position);
    this.buckets = next;
  }

  get size(): number {
    return this.buckets.length;
  }

  isEmpty(): boolean {
    return this.buckets.length === 0;
  }

  positionsFor(silo: SiloAddress): number[] {
    return this.buckets.filter((b) => b.silo === silo).map((b) => b.position);
  }

  /**
   * The silo owning `position`: the first bucket clockwise at or after it,
   * wrapping past 1.0 back to the first bucket.
   */
  ownerAt(position: number): SiloAddress | undefined {
    if (this.buckets.length === 0) return undefined;
    for (const bucket of this.buckets) {
      if (bucket.position >= position) return bucket.silo;
    }
    return this.buckets[0]?.silo;
  }

  /** The directory partition owner for a grain (or any hashable key). */
  ownerOf(key: string): SiloAddress | undefined {
    return this.ownerAt(ringPosition(key));
  }

  /**
   * One arc per bucket, each covering (predecessor, self]. Consecutive arcs
   * tile the whole ring with no gaps — asserted in ring.test.ts, because a gap
   * would mean grains that no silo is responsible for.
   */
  arcs(): RingArc[] {
    if (this.buckets.length === 0) return [];
    if (this.buckets.length === 1) {
      const only = this.buckets[0];
      if (!only) return [];
      // A single bucket owns the entire ring; represent it as a full wrap.
      return [{ silo: only.silo, start: only.position, end: only.position }];
    }

    return this.buckets.map((bucket, i) => {
      const predecessor = this.buckets[(i - 1 + this.buckets.length) % this.buckets.length];
      return {
        silo: bucket.silo,
        start: predecessor?.position ?? 0,
        end: bucket.position,
      };
    });
  }

  snapshot(): readonly RingBucket[] {
    return this.buckets;
  }
}
