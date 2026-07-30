// Grain cells — activations, set into the wall of their silo.
//
// A grain lives IN a silo, so it is drawn as a cell in the silo's cylindrical
// lattice rather than as a building standing next to it. Three things are
// drawn here and all three carry information:
//
//   LATTICE  every cell the silo has, dark and empty. Capacity has to be as
//            visible as occupancy — eleven lit cells out of a hundred and
//            sixty-two says something eleven lit cells alone cannot.
//
//   CELLS    one per activation, lit and standing proud of the wall. Hue is
//            inherited from the host silo, so a grain moving between silos is
//            a colour change you can see from across the plaza.
//
//   QUEUE    one marker per waiting request, stacked outward from the cell.
//            Encoding a queue as a size makes it a bar chart; drawing the
//            requests makes it something you can count.
//
// The lattice and queue markers are instanced: there are well over a thousand
// of them and they share a geometry, so one draw call each.

import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import { tag } from '../core/inspect';
import { siloColor } from '../core/theme';
import { hash32 } from '../sim/hash';
import type { ActivationView, GrainId, SiloAddress, SiloView } from '../sim/types';
import { LAYOUT, PLOTS_PER_BOROUGH, cellPlacement, preferredSlot } from './layout';
import { windowTextureFor } from './windows';

interface BuildingHandle {
  readonly mesh: Mesh<BoxGeometry, MeshStandardMaterial>;
  readonly slot: number;
  readonly silo: SiloAddress;
  readonly grainId: GrainId;
  /** Per-grain size variation, so the lattice is not perfectly uniform. */
  readonly heightScale: number;
  /** Outward-facing angle on the drum wall. */
  readonly angle: number;
  /** Cell position on the wall, before any outward push. */
  readonly base: { x: number; y: number; z: number };
}

function keyOf(silo: SiloAddress, grainId: GrainId): string {
  return `${silo}|${grainId}`;
}

/** Footprint by grain type, so the skyline is not one repeated shape. */
function footprintFor(view: ActivationView): number {
  if (view.persistent) return 0.78;
  if (view.reentrant) return 1.3;
  return 1;
}

/**
 * Stable per-grain height variation. Derived from the id so a grain is the
 * same height every time it activates, and so the skyline has a silhouette
 * rather than being one uniform row.
 */
function heightScaleFor(grainId: GrainId): number {
  return 0.7 + ((hash32(grainId) >>> 8) % 100) / 100 * 1.9;
}

const MAX_QUEUE_MARKERS = 900;

export class Buildings {
  readonly group = new Group();

  private readonly handles = new Map<string, BuildingHandle>();
  /** silo -> occupied plot slots, so two buildings never share a plot. */
  private readonly occupied = new Map<SiloAddress, Set<number>>();

  private readonly queueMarkers: InstancedMesh;
  private readonly scratch = new Object3D();
  private readonly hidden = new Matrix4().makeScale(0, 0, 0);

  constructor(
    private readonly indexOf: (silo: SiloAddress) => number,
    private readonly siloCount: number,
    silos: readonly SiloView[] = [],
  ) {
    this.group.add(this.buildPlotLattice(silos));

    this.queueMarkers = new InstancedMesh(
      new BoxGeometry(LAYOUT.queueMarkerSize, LAYOUT.queueMarkerSize, LAYOUT.queueMarkerSize),
      new MeshBasicMaterial({ color: 0xdfe7f2, transparent: true, opacity: 0.85 }),
      MAX_QUEUE_MARKERS,
    );
    this.queueMarkers.frustumCulled = false;
    this.group.add(this.queueMarkers);
  }

  /** Every cell the silos have, lit or not — the visible capacity. */
  private buildPlotLattice(silos: readonly SiloView[]): InstancedMesh {
    const total = Math.max(1, silos.length) * PLOTS_PER_BOROUGH;
    const pads = new InstancedMesh(
      new BoxGeometry(LAYOUT.cellSize, LAYOUT.cellSize, 0.28),
      new MeshBasicMaterial({ color: 0x2c3a4d, transparent: true, opacity: 0.5 }),
      total,
    );
    pads.frustumCulled = false;

    let i = 0;
    for (const silo of silos) {
      for (let slot = 0; slot < PLOTS_PER_BOROUGH; slot++) {
        const { position, angle } = cellPlacement(silo.index, silos.length, slot);
        this.scratch.position.copy(position);
        // Rotated to sit flush against the curved wall.
        this.scratch.rotation.set(0, -angle, 0);
        this.scratch.scale.set(1, 1, 1);
        this.scratch.updateMatrix();
        pads.setMatrixAt(i++, this.scratch.matrix);
      }
    }
    pads.count = i;
    pads.instanceMatrix.needsUpdate = true;
    return pads;
  }

  /** Plot for a grain on a silo, if it currently has a building there. */
  slotOf(silo: SiloAddress, grainId: GrainId): number | undefined {
    return this.handles.get(keyOf(silo, grainId))?.slot;
  }

  private claimSlot(silo: SiloAddress, grainId: GrainId): number {
    let used = this.occupied.get(silo);
    if (!used) {
      used = new Set();
      this.occupied.set(silo, used);
    }
    const preferred = preferredSlot(grainId);
    for (let probe = 0; probe < PLOTS_PER_BOROUGH; probe++) {
      const slot = (preferred + probe) % PLOTS_PER_BOROUGH;
      if (!used.has(slot)) {
        used.add(slot);
        return slot;
      }
    }
    // More activations on one silo than plots. Stack on the preferred plot
    // rather than dropping the building — an overfull borough should look
    // overfull, not silently lose tenants.
    return preferred;
  }

  sync(activations: readonly ActivationView[], now: number): void {
    const seen = new Set<string>();
    let markerIndex = 0;

    for (const activation of activations) {
      const { silo, grainId } = activation.address;
      const key = keyOf(silo, grainId);
      seen.add(key);

      let handle = this.handles.get(key);
      if (!handle) handle = this.create(silo, grainId);
      this.apply(handle, activation, now);
      markerIndex = this.layOutQueue(handle, activation, markerIndex);
    }

    for (let i = markerIndex; i < this.queueMarkers.count; i++) {
      this.queueMarkers.setMatrixAt(i, this.hidden);
    }
    this.queueMarkers.count = MAX_QUEUE_MARKERS;
    this.queueMarkers.instanceMatrix.needsUpdate = true;

    for (const [key, handle] of [...this.handles]) {
      if (seen.has(key)) continue;
      this.destroy(key, handle);
    }
  }

  /** Lines the waiting requests up outside the door, nearest first. */
  private layOutQueue(
    handle: BuildingHandle,
    activation: ActivationView,
    start: number,
  ): number {
    const shown = Math.min(activation.queueDepth, LAYOUT.maxQueueMarkers);
    let index = start;

    for (let i = 0; i < shown && index < MAX_QUEUE_MARKERS; i++) {
      // Queued calls hang in the air outside the cell door, nearest first.
      const reach = LAYOUT.cellDepth + 0.9 + (i + 1) * LAYOUT.queueMarkerGap;
      this.scratch.position.set(
        handle.base.x + Math.cos(handle.angle) * reach,
        handle.base.y,
        handle.base.z + Math.sin(handle.angle) * reach,
      );
      this.scratch.rotation.set(0, -handle.angle, 0);
      this.scratch.scale.set(1, 1, 1);
      this.scratch.updateMatrix();
      this.queueMarkers.setMatrixAt(index++, this.scratch.matrix);
    }
    return index;
  }

  private create(silo: SiloAddress, grainId: GrainId): BuildingHandle {
    const slot = this.claimSlot(silo, grainId);
    const boroughIndex = this.indexOf(silo);
    const { position, angle } = cellPlacement(boroughIndex, this.siloCount, slot);

    const heightScale = heightScaleFor(grainId);

    const mesh = new Mesh(
      new BoxGeometry(LAYOUT.buildingWidth, LAYOUT.buildingWidth, 1),
      new MeshStandardMaterial({
        // Dark casing, bright window. The emissive map is what the cell is
        // actually seen by — the base colour only tints the unlit shell.
        color: 0x0d1420,
        emissive: siloColor(boroughIndex, 62),
        emissiveMap: windowTextureFor(2),
        emissiveIntensity: 1,
        roughness: 0.7,
        metalness: 0.12,
        transparent: true,
        opacity: 1,
      }),
    );
    mesh.position.copy(position);
    mesh.rotation.y = -angle;
    mesh.castShadow = true;
    tag(mesh, { kind: 'activation', silo, grainId });

    this.group.add(mesh);
    const handle: BuildingHandle = {
      mesh,
      slot,
      silo,
      grainId,
      heightScale,
      angle,
      base: { x: position.x, y: position.y, z: position.z },
    };
    this.handles.set(keyOf(silo, grainId), handle);
    return handle;
  }

  private apply(handle: BuildingHandle, activation: ActivationView, now: number): void {
    const { mesh } = handle;
    const material = mesh.material;

    // A cell stands further proud of the wall the more work is stacked on it.
    const targetDepth =
      LAYOUT.cellDepth * (0.7 + handle.heightScale * 0.3) +
      activation.queueDepth * LAYOUT.buildingPerQueued;

    // Lifecycle reads as construction: a Creating grain is a translucent
    // footprint, Activating is a building going up, Valid is solid and lit.
    let depth = targetDepth;
    let opacity = 1;
    switch (activation.state) {
      case 'Creating':
        depth = LAYOUT.cellDepth * 0.2;
        opacity = 0.3;
        break;
      case 'Activating':
        depth = LAYOUT.cellDepth * 0.5;
        opacity = 0.6;
        break;
      case 'Deactivating':
        opacity = 0.4;
        break;
      case 'Invalid':
        opacity = 0.15;
        break;
      case 'Valid':
        break;
    }

    const footprint = footprintFor(activation);
    mesh.scale.set(footprint, footprint, Math.max(0.06, depth));
    // Push the cell outward along its own normal so it grows away from the
    // wall rather than sinking into the silo.
    const push = mesh.scale.z * 0.5;
    mesh.position.set(
      handle.base.x + Math.cos(handle.angle) * push,
      handle.base.y,
      handle.base.z + Math.sin(handle.angle) * push,
    );
    material.opacity = opacity;

    // Windows are always on; what varies is how hard they burn. Bloom turns
    // that into a visible halo, so "busy" is readable from across the map.
    const hue = siloColor(this.indexOf(handle.silo), 62);
    if (activation.blockedOn) {
      // Occupied but doing nothing: waiting on another grain. Amber so a
      // deadlock stands out from ordinary work.
      material.emissive.set(0xff9f43);
      material.emissiveIntensity = 2.0 + 0.7 * Math.sin(now / 130);
    } else if (activation.executing) {
      // A pulsing building is mid-turn — the revolving door from outside. At
      // most one turn drives this on a non-reentrant grain.
      material.emissive.set(hue);
      material.emissiveIntensity = 2.4 + 0.8 * Math.sin(now / 90);
    } else if (activation.collectible) {
      // Idle past the age limit: lights going out, due on the next sweep.
      material.emissive.set(0x4a5568);
      material.emissiveIntensity = 0.3;
      material.opacity = Math.min(opacity, 0.62);
    } else {
      material.emissive.set(hue);
      material.emissiveIntensity = 1.25;
    }
  }

  private destroy(key: string, handle: BuildingHandle): void {
    this.group.remove(handle.mesh);
    handle.mesh.geometry.dispose();
    handle.mesh.material.dispose();
    this.handles.delete(key);
    this.occupied.get(handle.silo)?.delete(handle.slot);
  }

  pickables(): Mesh[] {
    return [...this.handles.values()].map((h) => h.mesh);
  }
}

export { type BuildingHandle };
