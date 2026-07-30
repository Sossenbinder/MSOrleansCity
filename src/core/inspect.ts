// What the user can click, and what clicking it means.
//
// The inspector is the teaching surface (outline: Approach). Every pickable
// object in the city carries one of these tags in its three.js userData, and
// ui/inspector.ts turns the tag into: what you clicked -> the Orleans type
// behind it -> the configuration option that governs it in a real cluster.

import type { GrainId, SiloAddress } from '../sim/types';

export type Inspectable =
  | { readonly kind: 'silo'; readonly address: SiloAddress; readonly index: number }
  | { readonly kind: 'directory'; readonly address: SiloAddress; readonly index: number }
  | { readonly kind: 'activation'; readonly silo: SiloAddress; readonly grainId: GrainId }
  | { readonly kind: 'ring' }
  | { readonly kind: 'client' }
  | { readonly kind: 'townhall' }
  | { readonly kind: 'vault' }
  | { readonly kind: 'clocktower' }
  | { readonly kind: 'pullingagent'; readonly silo: SiloAddress }
  /** A message mid-route. Resolved against SimState.inFlight by id. */
  | { readonly kind: 'message'; readonly id: string };

export const INSPECT_KEY = 'inspectable';

export interface InspectableUserData {
  [INSPECT_KEY]?: Inspectable;
}

export function tag(target: { userData: Record<string, unknown> }, inspectable: Inspectable): void {
  target.userData[INSPECT_KEY] = inspectable;
}

export function readTag(userData: Record<string, unknown> | undefined): Inspectable | undefined {
  const value = userData?.[INSPECT_KEY];
  return value as Inspectable | undefined;
}

export function sameInspectable(a: Inspectable | undefined, b: Inspectable | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'silo':
    case 'directory':
      return a.address === (b as typeof a).address;
    case 'activation':
      return (
        a.silo === (b as typeof a).silo && a.grainId === (b as typeof a).grainId
      );
    case 'pullingagent':
      return a.silo === (b as typeof a).silo;
    case 'message':
      return a.id === (b as typeof a).id;
    default:
      return true;
  }
}
