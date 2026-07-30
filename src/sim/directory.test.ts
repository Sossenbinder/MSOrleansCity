import { describe, expect, it } from 'vitest';
import { GrainDirectory } from './directory';
import type { GrainAddress } from './types';

const OWNER = 'silo-a';

function addr(activationId: string, silo: string, grainId = 'user/42'): GrainAddress {
  return { grainId, activationId, silo };
}

describe('GrainDirectory partitions', () => {
  it('records the first registration', () => {
    const dir = new GrainDirectory();
    const result = dir.register(OWNER, addr('a1', 'silo-b'));

    expect(result.won).toBe(true);
    expect(result.winner.activationId).toBe('a1');
    expect(dir.lookup(OWNER, 'user/42')?.activationId).toBe('a1');
  });

  it('is first-writer-wins — this is the single-activation guarantee', () => {
    const dir = new GrainDirectory();
    dir.register(OWNER, addr('a1', 'silo-b'));

    const loser = dir.register(OWNER, addr('a2', 'silo-c'));

    expect(loser.won).toBe(false);
    expect(loser.winner.activationId).toBe('a1');
    expect(loser.winner.silo).toBe('silo-b');
    expect(dir.lookup(OWNER, 'user/42')?.activationId).toBe('a1');
  });

  it('lets the grain re-register after the winner unregisters', () => {
    const dir = new GrainDirectory();
    dir.register(OWNER, addr('a1', 'silo-b'));
    expect(dir.unregister(OWNER, 'user/42', 'a1')).toBe(true);

    const second = dir.register(OWNER, addr('a2', 'silo-c'));
    expect(second.won).toBe(true);
  });

  it('refuses to unregister an activation it does not name', () => {
    // A slow deactivation must not delete the newer activation that replaced it.
    const dir = new GrainDirectory();
    dir.register(OWNER, addr('a2', 'silo-c'));

    expect(dir.unregister(OWNER, 'user/42', 'a1')).toBe(false);
    expect(dir.lookup(OWNER, 'user/42')?.activationId).toBe('a2');
  });

  it('keeps partitions independent', () => {
    const dir = new GrainDirectory();
    dir.register('silo-a', addr('a1', 'silo-a', 'user/1'));
    dir.register('silo-b', addr('a2', 'silo-b', 'user/2'));

    expect(dir.entryCount('silo-a')).toBe(1);
    expect(dir.lookup('silo-a', 'user/2')).toBeUndefined();
  });

  it('finds every registration hosted on a given silo', () => {
    const dir = new GrainDirectory();
    dir.register('silo-a', addr('a1', 'silo-c', 'user/1'));
    dir.register('silo-b', addr('a2', 'silo-c', 'user/2'));
    dir.register('silo-b', addr('a3', 'silo-b', 'user/3'));

    expect(dir.registrationsHostedOn('silo-c').map((a) => a.grainId).sort()).toEqual([
      'user/1',
      'user/2',
    ]);
  });
});

describe('GrainDirectory caches', () => {
  it('is per-silo and non-authoritative', () => {
    const dir = new GrainDirectory();
    dir.cachePut('silo-a', addr('a1', 'silo-c'));

    expect(dir.cacheGet('silo-a', 'user/42')?.activationId).toBe('a1');
    expect(dir.cacheGet('silo-b', 'user/42')).toBeUndefined();
    // Caching must never create an authoritative record.
    expect(dir.lookup('silo-a', 'user/42')).toBeUndefined();
  });

  it('invalidates one silo, or everywhere', () => {
    const dir = new GrainDirectory();
    dir.cachePut('silo-a', addr('a1', 'silo-c'));
    dir.cachePut('silo-b', addr('a1', 'silo-c'));

    dir.cacheInvalidate('silo-a', 'user/42');
    expect(dir.cacheGet('silo-a', 'user/42')).toBeUndefined();
    expect(dir.cacheGet('silo-b', 'user/42')).toBeDefined();

    dir.cacheInvalidateEverywhere('user/42');
    expect(dir.cacheGet('silo-b', 'user/42')).toBeUndefined();
  });
});
