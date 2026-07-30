// The grain directory — the city's land registry.
//
// Two distinct things live here, and conflating them is the single most common
// misunderstanding of Orleans' directory:
//
//   PARTITIONS  the authoritative record. Sharded across silos by the ring.
//               Exactly one silo is the owner for any given grain, and its
//               answer is the truth.
//
//   CACHES      a per-silo, non-authoritative copy of "where did I last see
//               this grain". Every silo keeps one to skip the directory hop.
//               It can be stale, and staleness is not a bug — it is resolved
//               lazily by the target rejecting the message and the caller
//               invalidating the entry.
//
// Registration is FIRST-WRITER-WINS. That single rule is what gives Orleans its
// single-activation guarantee: two silos can race to create the same grain, but
// only one registration is recorded, and the loser destroys its own activation
// and defers to the winner.

import type { ActivationId, GrainAddress, GrainId, SiloAddress } from './types';

export interface RegisterResult {
  /** The registration that is now authoritative. */
  readonly winner: GrainAddress;
  /** False when someone else was already registered — the caller lost. */
  readonly won: boolean;
}

export class GrainDirectory {
  /** silo -> (grainId -> address). The authoritative shards. */
  private readonly partitions = new Map<SiloAddress, Map<GrainId, GrainAddress>>();

  /** silo -> (grainId -> address). Non-authoritative, may be stale. */
  private readonly caches = new Map<SiloAddress, Map<GrainId, GrainAddress>>();

  private partition(silo: SiloAddress): Map<GrainId, GrainAddress> {
    let p = this.partitions.get(silo);
    if (!p) {
      p = new Map();
      this.partitions.set(silo, p);
    }
    return p;
  }

  private cache(silo: SiloAddress): Map<GrainId, GrainAddress> {
    let c = this.caches.get(silo);
    if (!c) {
      c = new Map();
      this.caches.set(silo, c);
    }
    return c;
  }

  // -- authoritative partition ---------------------------------------------

  /**
   * First-writer-wins. If `candidate.grainId` is already registered, the
   * existing address is returned and `won` is false.
   */
  register(ownerSilo: SiloAddress, candidate: GrainAddress): RegisterResult {
    const partition = this.partition(ownerSilo);
    const existing = partition.get(candidate.grainId);
    if (existing) {
      return { winner: existing, won: false };
    }
    partition.set(candidate.grainId, candidate);
    return { winner: candidate, won: true };
  }

  lookup(ownerSilo: SiloAddress, grainId: GrainId): GrainAddress | undefined {
    return this.partitions.get(ownerSilo)?.get(grainId);
  }

  /**
   * Removes a registration, but only if it still names this exact activation.
   * The activationId check matters: a slow deactivation must not delete a
   * newer activation that has already registered in its place.
   */
  unregister(ownerSilo: SiloAddress, grainId: GrainId, activationId: ActivationId): boolean {
    const partition = this.partitions.get(ownerSilo);
    const existing = partition?.get(grainId);
    if (!partition || !existing || existing.activationId !== activationId) return false;
    partition.delete(grainId);
    return true;
  }

  entryCount(silo: SiloAddress): number {
    return this.partitions.get(silo)?.size ?? 0;
  }

  entries(silo: SiloAddress): readonly GrainAddress[] {
    return [...(this.partitions.get(silo)?.values() ?? [])];
  }

  /** Every registration pointing at activations hosted on `silo`, anywhere. */
  registrationsHostedOn(silo: SiloAddress): GrainAddress[] {
    const found: GrainAddress[] = [];
    for (const partition of this.partitions.values()) {
      for (const address of partition.values()) {
        if (address.silo === silo) found.push(address);
      }
    }
    return found;
  }

  /** Drops a silo's partition wholesale. P1 uses this when a silo dies. */
  dropPartition(silo: SiloAddress): GrainAddress[] {
    const lost = [...(this.partitions.get(silo)?.values() ?? [])];
    this.partitions.delete(silo);
    return lost;
  }

  // -- non-authoritative cache ---------------------------------------------

  cacheGet(silo: SiloAddress, grainId: GrainId): GrainAddress | undefined {
    return this.caches.get(silo)?.get(grainId);
  }

  cachePut(silo: SiloAddress, address: GrainAddress): void {
    this.cache(silo).set(address.grainId, address);
  }

  cacheInvalidate(silo: SiloAddress, grainId: GrainId): void {
    this.caches.get(silo)?.delete(grainId);
  }

  /** Invalidates this grain everywhere. Used when an activation goes away. */
  cacheInvalidateEverywhere(grainId: GrainId): void {
    for (const cache of this.caches.values()) cache.delete(grainId);
  }

  /**
   * Drops one silo's cached pointers to activations on a now-dead silo.
   *
   * Per-observer on purpose: caches clear as the membership update reaches
   * each silo, not all at once, so a silo that has not heard yet still routes
   * to the dead host and gets a rejection. That window is real.
   */
  cacheInvalidateHostedOn(observer: SiloAddress, deadSilo: SiloAddress): number {
    const cache = this.caches.get(observer);
    if (!cache) return 0;
    let dropped = 0;
    for (const [grainId, address] of [...cache]) {
      if (address.silo !== deadSilo) continue;
      cache.delete(grainId);
      dropped++;
    }
    return dropped;
  }

  cacheCount(silo: SiloAddress): number {
    return this.caches.get(silo)?.size ?? 0;
  }

  clearCache(silo: SiloAddress): void {
    this.caches.delete(silo);
  }
}
