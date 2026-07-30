// THE SINGLE SOURCE OF TRUTH FOR GEOMETRY (outline: structural rule #1).
//
// Every coordinate, anchor and route in the city is defined here and nowhere
// else. District modules ask this file where things go; they never invent
// positions of their own. The moment two modules each decide where a borough
// is, flows start landing in the wrong place and the drift is very hard to
// track down — so if you need a position, add it here.
//
// Axes: +x east, +z south, +y up. The ring road lies on the y = 0 plane and
// the camera looks in from the north, so "north" is -z.

import { CatmullRomCurve3, QuadraticBezierCurve3, Vector3 } from 'three';
import { hash32 } from '../sim/hash';
import type { NodeRef, SiloAddress } from '../sim/types';

// THE VERTICAL SCHEME.
//
// Everything used to sit on one plane at roughly one height, which is why the
// city had no scale: with nothing tall and nothing layered, there is no reason
// to fly in and nothing to be dwarfed by. The city now occupies five distinct
// bands, and each district is built to a silhouette you can name from across
// the map without reading its label:
//
//   sky      y  40+   clients, arriving from outside the cluster
//   spires   y  16-58 directory towers, Town Hall, the Clock Tower
//   deck     y  10    borough platforms, carried on pylons
//   ground   y  0     streets, viaduct footings
//   below    y -26    the Vault
//
// The gap under the borough decks is load-bearing, visually: it is what makes
// the boroughs read as raised districts rather than as floor tiles.

export const LAYOUT = {
  /** The consistent-hash ring: an elevated viaduct, not a painted line. */
  ringRadius: 78,
  ringTube: 1.05,
  ringDeckY: 8.5,
  ringPillarEvery: 14,
  ringPillarWidth: 1.5,

  // -- THE SILO ------------------------------------------------------------
  //
  // Orleans calls them silos because grains are stored in silos. It is a
  // farming metaphor, and a grain silo is a tall cylindrical tower — so that
  // is what one is here. This is the single most important shape in the city:
  // five monumental drums around a plaza, each one a host process, each one
  // visibly CONTAINING its grains rather than having them scattered beside it.
  //
  // Activations are lit cells in a cylindrical lattice wrapping the drum. The
  // lattice is always drawn, so an almost-empty silo and a packed one are
  // different at a glance, and the silo has a capacity you can see.

  /** Distance from origin to the axis of each silo. */
  boroughOrbit: 46,
  siloRadius: 10,
  siloHeight: 34,
  plinthRadius: 12.5,
  plinthHeight: 2.6,
  roofHeight: 7,

  /** Cylindrical lattice of grain cells wrapping the drum. */
  cellColumns: 18,
  cellRows: 9,
  cellSize: 1.75,
  cellRowHeight: 2.7,
  /** Height of the lowest row of cells above the plinth. */
  cellFirstRowY: 3.2,
  /** How far a cell stands proud of the drum wall. */
  cellDepth: 1.25,

  /** The loading dock where client traffic enters, at the plaza-facing side. */
  gatewayHeight: 7,
  gatewayWidth: 8,
  gatewayOffset: 11.5,

  /** Ground plane extent. */
  groundSize: 1600,

  /** A cell protrudes further from the wall the more work is queued on it. */
  buildingBase: 1.0,
  buildingPerQueued: 0.34,
  buildingWidth: 1.68,

  /**
   * Queued requests are drawn as actual objects lined up at the door, not just
   * as building height. A queue you can count is worth more than a bar chart.
   */
  queueMarkerSize: 0.55,
  queueMarkerGap: 0.78,
  maxQueueMarkers: 10,

  /**
   * The registry gallery: a banded collar near the top of the drum holding
   * this silo's slice of the grain directory. A collar rather than a separate
   * tower, because the partition belongs TO the silo — but visually distinct
   * from the grain cells below it, because the grains it lists mostly live in
   * other silos entirely.
   */
  galleryY: 27.5,
  galleryRadius: 11.4,
  shelfHeight: 0.7,
  maxShelves: 34,

  clientAnchor: new Vector3(0, 74, -118),

  /**
   * Town Hall — the membership table. South of the plaza, deliberately NOT on
   * a borough plate: the membership table is shared storage outside any silo,
   * and drawing it inside one would teach the wrong thing.
   */
  townHall: new Vector3(0, 0, 30),
  townHallHeight: 23,
  townHallWidth: 15,
  townHallTiers: 3,

  /**
   * The Vault — grain storage, excavated under the plaza. Below ground because
   * it is the one thing that outlives every activation above it.
   */
  vault: new Vector3(0, -26, 0),
  vaultRadius: 17,
  vaultDepth: 26,
  vaultGalleries: 4,

  /**
   * Clock Tower — durable reminders. Placed OUTSIDE the ring road so its base
   * is not buried behind it: reminders are a service external to the cluster,
   * and it reads better as its own landmark than as another downtown building.
   */
  clockTower: new Vector3(92, 0, -26),
  clockTowerHeight: 40,
  clockTowerWidth: 5.2,

  /** Canals — stream delivery. Pulling agents sit beside their own borough. */
  agentOffset: 12.5,
  agentHeight: 5.5,

  /** Arc height of a message route, as a fraction of its ground distance. */
  routeLift: 0.28,
  routeMinLift: 4,
} as const;

/** Angle of a borough on the plaza. Index 0 sits due north. */
export function boroughAngle(index: number, count: number): number {
  return -Math.PI / 2 + (index / Math.max(1, count)) * Math.PI * 2;
}

export function boroughCenter(index: number, count: number): Vector3 {
  const angle = boroughAngle(index, count);
  return new Vector3(
    Math.cos(angle) * LAYOUT.boroughOrbit,
    0,
    Math.sin(angle) * LAYOUT.boroughOrbit,
  );
}

/** Axis position of a silo drum. */
export function siloCenter(index: number, count: number): Vector3 {
  return boroughCenter(index, count);
}

/**
 * A cell in the silo's cylindrical lattice.
 *
 * Columns wrap around the drum, rows climb it. Returns both the world position
 * on the drum wall and the outward-facing angle, because a cell has to be
 * rotated to sit flush against a curved surface.
 */
export function cellPlacement(
  index: number,
  count: number,
  slot: number,
): { position: Vector3; angle: number } {
  const total = PLOTS_PER_BOROUGH;
  const wrapped = ((slot % total) + total) % total;
  const col = wrapped % LAYOUT.cellColumns;
  const row = Math.floor(wrapped / LAYOUT.cellColumns);

  // Odd rows are offset half a column, so the lattice reads as masonry rather
  // than as a grid of floating squares.
  const stagger = row % 2 === 0 ? 0 : 0.5;
  const angle = ((col + stagger) / LAYOUT.cellColumns) * Math.PI * 2;
  const center = siloCenter(index, count);

  return {
    position: new Vector3(
      center.x + Math.cos(angle) * LAYOUT.siloRadius,
      LAYOUT.plinthHeight + LAYOUT.cellFirstRowY + row * LAYOUT.cellRowHeight,
      center.z + Math.sin(angle) * LAYOUT.siloRadius,
    ),
    angle,
  };
}

/** Where a vehicle bound for a grain aims: just outside its cell. */
export function cellAnchor(index: number, count: number, slot: number): Vector3 {
  const { position, angle } = cellPlacement(index, count, slot);
  return position
    .clone()
    .add(new Vector3(Math.cos(angle) * LAYOUT.cellDepth * 1.6, 0, Math.sin(angle) * LAYOUT.cellDepth * 1.6));
}

/** The loading dock on the plaza-facing side, where client traffic enters. */
export function gatewayAnchor(index: number, count: number): Vector3 {
  const angle = boroughAngle(index, count);
  const center = siloCenter(index, count);
  return new Vector3(
    center.x - Math.cos(angle) * LAYOUT.gatewayOffset,
    LAYOUT.plinthHeight + LAYOUT.gatewayHeight * 0.6,
    center.z - Math.sin(angle) * LAYOUT.gatewayOffset,
  );
}

export function gatewayBase(index: number, count: number): Vector3 {
  return gatewayAnchor(index, count).setY(LAYOUT.plinthHeight);
}

export function siloAnchor(index: number, count: number): Vector3 {
  return gatewayAnchor(index, count);
}

/** The registry collar near the top of the drum. */
export function directoryAnchor(index: number, count: number): Vector3 {
  const angle = boroughAngle(index, count);
  const center = siloCenter(index, count);
  return new Vector3(
    center.x + Math.cos(angle) * LAYOUT.galleryRadius,
    LAYOUT.galleryY + 1.4,
    center.z + Math.sin(angle) * LAYOUT.galleryRadius,
  );
}

export function directoryBase(index: number, count: number): Vector3 {
  return directoryAnchor(index, count).setY(LAYOUT.galleryY);
}

/** Cells in one silo's lattice — its visible activation capacity. */
export const PLOTS_PER_BOROUGH = LAYOUT.cellColumns * LAYOUT.cellRows;

/** Preferred starting slot for a grain, so layout is stable across runs. */
export function preferredSlot(grainId: string): number {
  return hash32(grainId) % PLOTS_PER_BOROUGH;
}

/** A point on the ring road, `t` in 0..1 clockwise from due north. */
export function ringPoint(t: number, y = 0): Vector3 {
  const angle = -Math.PI / 2 + t * Math.PI * 2;
  return new Vector3(
    Math.cos(angle) * LAYOUT.ringRadius,
    y,
    Math.sin(angle) * LAYOUT.ringRadius,
  );
}

/** Samples an arc of the ring road, used to draw directory-partition arcs. */
export function ringArcPoints(start: number, end: number, segments = 48): Vector3[] {
  const span = end >= start ? end - start : 1 - start + end;
  const points: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    points.push(ringPoint((start + (span * i) / segments) % 1, LAYOUT.ringDeckY + 0.45));
  }
  return points;
}

/**
 * Resolves any sim NodeRef to a world position. This is the ONLY place the
 * mapping exists — sim/ names nodes, world/ knows where they are.
 */
export function anchorFor(
  node: NodeRef,
  indexOf: (silo: SiloAddress) => number,
  count: number,
  slotOf: (silo: SiloAddress, grainId: string) => number | undefined,
): Vector3 {
  switch (node.kind) {
    case 'client':
      return LAYOUT.clientAnchor.clone();
    case 'silo':
      return siloAnchor(indexOf(node.silo), count);
    case 'directory':
      return directoryAnchor(indexOf(node.silo), count);
    case 'activation': {
      const boroughIndex = indexOf(node.silo);
      const slot = slotOf(node.silo, node.grainId);
      if (slot === undefined) return siloAnchor(boroughIndex, count);
      return cellAnchor(boroughIndex, count, slot);
    }
    case 'townhall':
      return townHallAnchor();
    case 'vault':
      return vaultAnchor();
    case 'clocktower':
      return clockTowerAnchor();
    case 'pullingagent':
      return pullingAgentAnchor(indexOf(node.silo), count);
  }
}

export function townHallAnchor(): Vector3 {
  return LAYOUT.townHall.clone().setY(LAYOUT.townHallHeight * 0.72);
}

export function vaultAnchor(): Vector3 {
  // Just above the vault floor, so storage traffic dives into the shaft.
  return LAYOUT.vault.clone().setY(-LAYOUT.vaultDepth * 0.62);
}

export function clockTowerAnchor(): Vector3 {
  return LAYOUT.clockTower.clone().setY(LAYOUT.clockTowerHeight * 0.85);
}

/** A pulling agent runs ON a silo, so it stands beside its own borough. */
export function pullingAgentAnchor(index: number, count: number): Vector3 {
  const angle = boroughAngle(index, count);
  const center = siloCenter(index, count);
  return new Vector3(
    center.x - Math.sin(angle) * LAYOUT.agentOffset,
    LAYOUT.plinthHeight + LAYOUT.agentHeight * 0.5,
    center.z + Math.cos(angle) * LAYOUT.agentOffset,
  );
}

/**
 * The road a vehicle takes. Messages arc through the air rather than running
 * along the ground: a straight line between two boroughs would pass through
 * whatever sits between them, and the arc makes direction readable.
 */
export function routeCurve(from: Vector3, to: Vector3): QuadraticBezierCurve3 {
  const mid = from.clone().add(to).multiplyScalar(0.5);
  const lift = Math.max(LAYOUT.routeMinLift, from.distanceTo(to) * LAYOUT.routeLift);
  mid.y = Math.max(from.y, to.y) + lift;
  return new QuadraticBezierCurve3(from.clone(), mid, to.clone());
}

/** A smooth closed curve through the ring, for the road mesh itself. */
export function ringCurve(): CatmullRomCurve3 {
  const points: Vector3[] = [];
  for (let i = 0; i < 96; i++) points.push(ringPoint(i / 96));
  return new CatmullRomCurve3(points, true, 'catmullrom', 0.5);
}
