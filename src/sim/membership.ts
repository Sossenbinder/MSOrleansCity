// Cluster membership — the Town Hall ledger and the patrols.
//
// Orleans has no master, no leader election and no external coordinator
// deciding who is alive. Instead:
//
//   - Every silo owns one row in a shared membership table and stamps it
//     periodically to say "still here" (IAmAlive).
//   - Every silo directly pings a SMALL, FIXED number of ring neighbours.
//     Nobody watches everybody; probe traffic stays linear in cluster size.
//   - A watcher that misses several consecutive pings files a suspicion vote
//     into the suspect's row. A vote is an accusation, not a verdict.
//   - Once enough INDEPENDENT silos have voted, the suspect is declared Dead.
//     That quorum is the whole point: one silo with a broken NIC can accuse
//     everyone and evict nobody.
//
// Two paths, deliberately kept distinct here and in the city: probes are
// peer-to-peer, IAmAlive and votes are writes to shared storage. People
// routinely assume Orleans failure detection runs through the membership
// table. It does not — the table is where conclusions are recorded, not how
// they are reached.
//
// This file holds membership STATE and pure decisions. Scheduling probes and
// putting them on the network is cluster.ts's job, exactly as directory.ts
// holds directory state and cluster.ts routes to it.

import { COUNTS, requiredVotes } from './config';
import { ringPosition } from './hash';
import type { SiloAddress, SiloStatus } from './types';

export interface MembershipRow {
  readonly address: SiloAddress;
  status: SiloStatus;
  readonly startedAt: number;
  iAmAliveAt: number;
  /** voter -> when the vote was cast. Votes expire. */
  readonly suspectors: Map<SiloAddress, number>;
}

/** Statuses that count as "participating in the cluster right now". */
export function isAlive(status: SiloStatus): boolean {
  return status === 'Active' || status === 'Joining' || status === 'ShuttingDown';
}

export class MembershipTable {
  private readonly rows = new Map<SiloAddress, MembershipRow>();
  /** Bumped on every status change, so silos can detect a stale view. */
  version = 0;

  seed(addresses: readonly SiloAddress[], now: number): void {
    for (const address of addresses) {
      this.rows.set(address, {
        address,
        status: 'Active',
        startedAt: now,
        iAmAliveAt: now,
        suspectors: new Map(),
      });
    }
    this.version++;
  }

  row(address: SiloAddress): MembershipRow | undefined {
    return this.rows.get(address);
  }

  all(): readonly MembershipRow[] {
    return [...this.rows.values()];
  }

  activeAddresses(): SiloAddress[] {
    return this.all()
      .filter((r) => r.status === 'Active')
      .map((r) => r.address);
  }

  activeCount(): number {
    return this.activeAddresses().length;
  }

  recordIAmAlive(address: SiloAddress, now: number): void {
    const row = this.rows.get(address);
    if (!row || !isAlive(row.status)) return;
    row.iAmAliveAt = now;
  }

  setStatus(address: SiloAddress, status: SiloStatus): SiloStatus | undefined {
    const row = this.rows.get(address);
    if (!row || row.status === status) return undefined;
    const previous = row.status;
    row.status = status;
    this.version++;
    // A dead silo's accusations are meaningless, and it can no longer defend
    // itself, so its own row's votes are cleared rather than left to expire.
    if (status === 'Dead') row.suspectors.clear();
    return previous;
  }

  /** Records a vote. Re-voting refreshes the timestamp rather than double-counting. */
  addSuspicion(suspect: SiloAddress, voter: SiloAddress, now: number): void {
    const row = this.rows.get(suspect);
    if (!row || row.status === 'Dead') return;
    row.suspectors.set(voter, now);
  }

  /**
   * Votes that are still valid. Expiry matters: a silo that was briefly
   * unreachable must not accumulate votes across unrelated incidents and get
   * evicted an hour later for a blip it already recovered from.
   */
  freshVotes(suspect: SiloAddress, now: number, expiryMs: number): SiloAddress[] {
    const row = this.rows.get(suspect);
    if (!row) return [];
    const fresh: SiloAddress[] = [];
    for (const [voter, votedAt] of row.suspectors) {
      if (now - votedAt <= expiryMs) fresh.push(voter);
    }
    return fresh;
  }

  /**
   * Drops expired votes. Kept separate from freshVotes so that reading the
   * vote count stays side-effect free — snapshot() calls it every frame and
   * must not mutate anything.
   */
  pruneVotes(now: number, expiryMs: number): void {
    for (const row of this.rows.values()) {
      for (const [voter, votedAt] of [...row.suspectors]) {
        if (now - votedAt > expiryMs) row.suspectors.delete(voter);
      }
    }
  }

  votesRequiredFor(): number {
    return requiredVotes(this.activeCount());
  }
}

/**
 * Which peers a silo watches: its successors on the membership ring.
 *
 * Using ring order rather than a random subset is what makes the watch graph
 * a connected cycle — every silo is watched by someone, and the assignment is
 * stable, so a membership change reshuffles the minimum number of watchers.
 */
export function probeTargets(
  self: SiloAddress,
  activeSilos: readonly SiloAddress[],
  howMany: number = COUNTS.numProbedSilos.simulated,
): SiloAddress[] {
  const ordered = [...activeSilos].sort((a, b) => ringPosition(a) - ringPosition(b));
  const selfIndex = ordered.indexOf(self);
  if (selfIndex < 0 || ordered.length <= 1) return [];

  const limit = Math.min(howMany, ordered.length - 1);
  const targets: SiloAddress[] = [];
  for (let step = 1; targets.length < limit && step < ordered.length; step++) {
    const candidate = ordered[(selfIndex + step) % ordered.length];
    if (candidate && candidate !== self) targets.push(candidate);
  }
  return targets;
}

interface OutstandingProbe {
  readonly prober: SiloAddress;
  readonly target: SiloAddress;
  readonly deadline: number;
}

/**
 * Tracks pings in flight and consecutive misses per (watcher, target) pair.
 *
 * Misses must be CONSECUTIVE — a single answered ping resets the counter.
 * Otherwise a healthy silo would accumulate misses over hours of normal
 * packet loss and eventually be evicted for no reason.
 */
export class ProbeTracker {
  private readonly outstanding = new Map<string, OutstandingProbe>();
  private readonly consecutiveMisses = new Map<string, number>();
  private nextId = 0;

  private static pairKey(prober: SiloAddress, target: SiloAddress): string {
    return `${prober}->${target}`;
  }

  issue(prober: SiloAddress, target: SiloAddress, deadline: number): string {
    const probeId = `p${this.nextId++}`;
    this.outstanding.set(probeId, { prober, target, deadline });
    return probeId;
  }

  /** True when the ack was expected; resets that pair's miss counter. */
  acknowledge(probeId: string): boolean {
    const probe = this.outstanding.get(probeId);
    if (!probe) return false;
    this.outstanding.delete(probeId);
    this.consecutiveMisses.set(ProbeTracker.pairKey(probe.prober, probe.target), 0);
    return true;
  }

  /** Probes whose deadline has passed, with the resulting consecutive count. */
  collectExpired(now: number): Array<{ prober: SiloAddress; target: SiloAddress; consecutive: number }> {
    const expired: Array<{ prober: SiloAddress; target: SiloAddress; consecutive: number }> = [];
    for (const [probeId, probe] of [...this.outstanding]) {
      if (probe.deadline > now) continue;
      this.outstanding.delete(probeId);
      const key = ProbeTracker.pairKey(probe.prober, probe.target);
      const consecutive = (this.consecutiveMisses.get(key) ?? 0) + 1;
      this.consecutiveMisses.set(key, consecutive);
      expired.push({ prober: probe.prober, target: probe.target, consecutive });
    }
    return expired;
  }

  missesFor(prober: SiloAddress, target: SiloAddress): number {
    return this.consecutiveMisses.get(ProbeTracker.pairKey(prober, target)) ?? 0;
  }

  hasOutstanding(prober: SiloAddress, target: SiloAddress): boolean {
    for (const probe of this.outstanding.values()) {
      if (probe.prober === prober && probe.target === target) return true;
    }
    return false;
  }

  /** Forgets everything involving a silo. Called once it is declared dead. */
  forget(silo: SiloAddress): void {
    for (const [probeId, probe] of [...this.outstanding]) {
      if (probe.prober === silo || probe.target === silo) this.outstanding.delete(probeId);
    }
    for (const key of [...this.consecutiveMisses.keys()]) {
      if (key.startsWith(`${silo}->`) || key.endsWith(`->${silo}`)) {
        this.consecutiveMisses.delete(key);
      }
    }
  }
}
