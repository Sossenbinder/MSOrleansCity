// Stable 32-bit hashing for ring placement.
//
// ACCURACY NOTE: Orleans computes ring positions from
// `SiloAddress.GetConsistentHashCode()` and `GrainId.GetUniformHashCode()`,
// which are Jenkins-derived and NOT this function. We use FNV-1a as a
// stand-in: what the city teaches is that identity maps deterministically and
// uniformly onto a ring, and that the mapping is stable across membership
// changes. Reproducing Orleans' exact bit pattern would change none of that,
// so it is deliberately out of scope. Do not present these positions as the
// values a real cluster would compute.

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a, returned as an unsigned 32-bit integer. */
export function hash32(value: string): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

export const RING_SPACE = 0x100000000;

/** Ring position in [0, 1), convenient for both arc geometry and comparison. */
export function ringPosition(value: string): number {
  return hash32(value) / RING_SPACE;
}
