// Grain storage — the Vault.
//
// Orleans does not persist grain state for you. A grain that wants durable
// state declares IPersistentState<T> and calls WriteStateAsync explicitly;
// everything else lives and dies with the activation. This is the single most
// common surprise about the virtual actor model, so the vault is deliberately
// a separate district you have to travel to.
//
// Writes carry an ETag. If the stored ETag has moved on since the writer read
// it, the write is REJECTED rather than applied. That is what protects state
// when a network partition briefly leaves two activations believing they own
// the same grain: the stale one loses.

import type { GrainAddress, GrainId } from './types';

export interface StoredState {
  readonly grainId: GrainId;
  etag: number;
  version: number;
}

export interface WriteResult {
  readonly accepted: boolean;
  /** The ETag now in storage — the new one on success, the current one on conflict. */
  readonly etag: number;
  readonly version: number;
}

export class GrainStorage {
  private readonly rows = new Map<GrainId, StoredState>();
  private conflicts = 0;
  private nextEtag = 1;

  /** Reading a grain that has never been written yields version 0, not an error. */
  read(grainId: GrainId): StoredState {
    let row = this.rows.get(grainId);
    if (!row) {
      row = { grainId, etag: 0, version: 0 };
      this.rows.set(grainId, row);
    }
    return { ...row };
  }

  /**
   * Optimistic concurrency. `expectedEtag` is what the writer last saw; if
   * storage has moved past it, nothing is written.
   */
  write(grainId: GrainId, expectedEtag: number): WriteResult {
    const row = this.rows.get(grainId) ?? { grainId, etag: 0, version: 0 };
    if (row.etag !== expectedEtag) {
      this.conflicts++;
      return { accepted: false, etag: row.etag, version: row.version };
    }
    row.etag = this.nextEtag++;
    row.version += 1;
    this.rows.set(grainId, row);
    return { accepted: true, etag: row.etag, version: row.version };
  }

  clear(grainId: GrainId): void {
    this.rows.delete(grainId);
  }

  get grainCount(): number {
    return this.rows.size;
  }

  get totalVersions(): number {
    let total = 0;
    for (const row of this.rows.values()) total += row.version;
    return total;
  }

  get conflictCount(): number {
    return this.conflicts;
  }

  versionOf(grainId: GrainId): number {
    return this.rows.get(grainId)?.version ?? 0;
  }

  /** Every stored grain, so the vault district can draw a cell per row. */
  entries(): Array<{ grainId: GrainId; version: number }> {
    return [...this.rows.values()]
      .filter((row) => row.version > 0)
      .map((row) => ({ grainId: row.grainId, version: row.version }));
  }
}

/** Per-activation view of storage: what this activation last read or wrote. */
export interface PersistentStateHandle {
  etag: number;
  version: number;
  writes: number;
  conflicts: number;
  loaded: boolean;
}

export function newStateHandle(): PersistentStateHandle {
  return { etag: 0, version: 0, writes: 0, conflicts: 0, loaded: false };
}

export function describeAddress(address: GrainAddress): string {
  return `${address.grainId}@${address.silo}`;
}
