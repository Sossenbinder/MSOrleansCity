// Silos.
//
// Orleans calls them silos because grains are stored in silos — it is a
// farming metaphor, and a grain silo is a tall cylindrical tower. So that is
// what one is here, and it is the most important shape in the city: five
// monumental drums around a plaza, each one a host process, each one visibly
// CONTAINING its grains rather than having them scattered on a plate beside it.
//
// Reading a silo from the ground up:
//
//   PLINTH    the base it stands on, with the loading dock facing the plaza
//   DOCK      where client calls enter — the gateway, at ground level
//   LATTICE   the cylindrical grid of grain cells wrapping the drum. Always
//             drawn in full, so capacity is as visible as occupancy and a
//             nearly-empty silo looks nearly empty (see buildings.ts)
//   COLLAR    a banded gallery near the top holding this silo's slice of the
//             grain directory. Attached to the silo because the partition
//             belongs to it, but visually distinct from the cells below,
//             because the grains it lists mostly live in OTHER silos
//   ROOF      a cone with a lantern, so the skyline has a silhouette
//
// The drum is deliberately hollow-looking at the top: the collar and roof
// overhang the wall, which is what makes it read as a container.

import {
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  TorusGeometry,
} from 'three';
import { tag } from '../core/inspect';
import { PALETTE, hslHex, siloColor } from '../core/theme';
import type { SiloAddress, SiloView } from '../sim/types';
import {
  LAYOUT,
  boroughAngle,
  gatewayBase,
  siloCenter,
} from './layout';

export interface BoroughHandle {
  readonly address: SiloAddress;
  readonly index: number;
  readonly group: Group;
  readonly drum: Mesh<CylinderGeometry, MeshStandardMaterial>;
  readonly plinth: Mesh<CylinderGeometry, MeshStandardMaterial>;
  readonly collar: Mesh<CylinderGeometry, MeshStandardMaterial>;
  readonly roof: Mesh<ConeGeometry, MeshStandardMaterial>;
  readonly lantern: Mesh<CylinderGeometry, MeshStandardMaterial>;
  readonly dock: Mesh<BoxGeometry, MeshStandardMaterial>;
  readonly bands: Mesh<TorusGeometry, MeshStandardMaterial>[];
  readonly shelves: InstancedMesh;
  readonly center: { x: number; z: number };
}

export class Boroughs {
  readonly group = new Group();
  private readonly handles = new Map<SiloAddress, BoroughHandle>();
  private readonly scratch = new Object3D();

  constructor(silos: readonly SiloView[]) {
    for (const silo of silos) this.add(silo, silos.length);
  }

  private add(silo: SiloView, count: number): void {
    const group = new Group();
    const center = siloCenter(silo.index, count);
    const angle = boroughAngle(silo.index, count);
    const hue = siloColor(silo.index, 62);

    // -- plinth --------------------------------------------------------------
    const plinth = new Mesh(
      new CylinderGeometry(LAYOUT.plinthRadius, LAYOUT.plinthRadius * 1.08, LAYOUT.plinthHeight, 24),
      new MeshStandardMaterial({ color: 0x141d29, roughness: 0.92, metalness: 0.15 }),
    );
    plinth.position.set(center.x, LAYOUT.plinthHeight / 2, center.z);
    plinth.receiveShadow = true;
    plinth.castShadow = true;
    tag(plinth, { kind: 'silo', address: silo.address, index: silo.index });

    // -- the drum ------------------------------------------------------------
    const drum = new Mesh(
      new CylinderGeometry(LAYOUT.siloRadius, LAYOUT.siloRadius * 1.02, LAYOUT.siloHeight, 32),
      new MeshStandardMaterial({
        color: 0x0f1926,
        emissive: hue,
        emissiveIntensity: 0.06,
        roughness: 0.78,
        metalness: 0.22,
      }),
    );
    drum.position.set(center.x, LAYOUT.plinthHeight + LAYOUT.siloHeight / 2, center.z);
    drum.castShadow = true;
    drum.receiveShadow = true;
    tag(drum, { kind: 'silo', address: silo.address, index: silo.index });

    // Hoop bands up the wall. Repetition at a known spacing is what gives the
    // drum a readable size — it is the main scale cue on the whole structure.
    const bands: Mesh<TorusGeometry, MeshStandardMaterial>[] = [];
    for (let i = 0; i < LAYOUT.cellRows + 1; i++) {
      const band = new Mesh(
        new TorusGeometry(LAYOUT.siloRadius * 1.008, 0.16, 6, 40),
        new MeshStandardMaterial({
          color: 0x223244,
          emissive: hue,
          emissiveIntensity: 0.22,
          roughness: 0.6,
          metalness: 0.45,
        }),
      );
      band.rotation.x = -Math.PI / 2;
      band.position.set(
        center.x,
        LAYOUT.plinthHeight + LAYOUT.cellFirstRowY - LAYOUT.cellRowHeight * 0.5 + i * LAYOUT.cellRowHeight,
        center.z,
      );
      bands.push(band);
      group.add(band);
    }

    // -- registry collar -----------------------------------------------------
    const collar = new Mesh(
      new CylinderGeometry(LAYOUT.galleryRadius, LAYOUT.galleryRadius, 2.4, 32, 1, true),
      new MeshStandardMaterial({
        color: 0x2a2418,
        emissive: PALETTE.directoryOffice,
        emissiveIntensity: 0.5,
        roughness: 0.45,
        metalness: 0.5,
        side: 2,
      }),
    );
    collar.position.set(center.x, LAYOUT.galleryY, center.z);
    collar.castShadow = true;
    tag(collar, { kind: 'directory', address: silo.address, index: silo.index });

    // One shelf per registration, arranged around the collar.
    const shelves = new InstancedMesh(
      new BoxGeometry(1.5, LAYOUT.shelfHeight, 0.85),
      new MeshStandardMaterial({
        color: 0x3b331d,
        emissive: PALETTE.directoryOffice,
        emissiveIntensity: 1.0,
        roughness: 0.4,
        metalness: 0.4,
      }),
      LAYOUT.maxShelves,
    );
    shelves.frustumCulled = false;
    shelves.count = 0;

    // -- roof ----------------------------------------------------------------
    const roofY = LAYOUT.plinthHeight + LAYOUT.siloHeight;
    const roof = new Mesh(
      new ConeGeometry(LAYOUT.siloRadius * 1.18, LAYOUT.roofHeight, 32),
      new MeshStandardMaterial({
        color: 0x1a2635,
        emissive: hue,
        emissiveIntensity: 0.14,
        roughness: 0.7,
        metalness: 0.3,
      }),
    );
    roof.position.set(center.x, roofY + LAYOUT.roofHeight / 2, center.z);
    roof.castShadow = true;
    tag(roof, { kind: 'silo', address: silo.address, index: silo.index });

    // The lantern is the silo's identity light — the clearest "is this silo
    // alive" signal in the city, readable from the far side of the ring.
    const lantern = new Mesh(
      new CylinderGeometry(0.72, 0.72, 2.6, 10),
      new MeshStandardMaterial({ color: hue, emissive: hue, emissiveIntensity: 2.2 }),
    );
    lantern.position.set(center.x, roofY + LAYOUT.roofHeight + 1.1, center.z);
    tag(lantern, { kind: 'silo', address: silo.address, index: silo.index });

    // -- loading dock (the gateway) -----------------------------------------
    const dockAt = gatewayBase(silo.index, count);
    const dock = new Mesh(
      new BoxGeometry(LAYOUT.gatewayWidth, LAYOUT.gatewayHeight, 4.4),
      new MeshStandardMaterial({
        color: 0x1d2836,
        emissive: PALETTE.clientSky,
        emissiveIntensity: 0.32,
        roughness: 0.6,
        metalness: 0.3,
      }),
    );
    dock.position.set(dockAt.x, LAYOUT.plinthHeight + LAYOUT.gatewayHeight / 2, dockAt.z);
    dock.rotation.y = -angle;
    dock.castShadow = true;
    tag(dock, { kind: 'silo', address: silo.address, index: silo.index });

    // A lit apron in front of the dock, so the entrance reads as an entrance.
    const apron = new Mesh(
      new CircleGeometry(LAYOUT.gatewayWidth * 0.62, 20),
      new MeshStandardMaterial({
        color: 0x0e1a26,
        emissive: PALETTE.clientSky,
        emissiveIntensity: 0.14,
        roughness: 0.9,
      }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(dockAt.x, LAYOUT.plinthHeight + 0.04, dockAt.z);

    group.add(plinth, drum, collar, shelves, roof, lantern, dock, apron);
    this.group.add(group);

    this.handles.set(silo.address, {
      address: silo.address,
      index: silo.index,
      group,
      drum,
      plinth,
      collar,
      roof,
      lantern,
      dock,
      bands,
      shelves,
      center: { x: center.x, z: center.z },
    });
  }

  /**
   * Reflects live silo state. Four distinct conditions, and telling them apart
   * is the whole P1 lesson:
   *
   *   healthy    lantern lit in the silo's hue, collar glowing with its load
   *   crashed    lantern out — the process is gone, but the CLUSTER still
   *              believes it is Active and keeps routing to it
   *   suspected  bands burn orange as votes accumulate against it
   *   dead       dark, and now nobody routes to it
   */
  sync(silos: readonly SiloView[], now: number): void {
    for (const silo of silos) {
      const handle = this.handles.get(silo.address);
      if (!handle) continue;

      const dead = silo.status === 'Dead';
      const gone = dead || silo.crashed;
      const hue = siloColor(silo.index, 62);

      handle.lantern.visible = !gone;
      handle.lantern.material.emissiveIntensity = gone ? 0 : 2.2;

      const load = Math.min(1, silo.directoryEntryCount / 18);
      handle.collar.material.emissiveIntensity = gone ? 0.02 : 0.4 + load * 0.9;
      this.stackShelves(handle, gone ? 0 : silo.directoryEntryCount);

      handle.dock.material.emissiveIntensity = gone ? 0 : 0.32;
      handle.drum.material.emissiveIntensity = gone ? 0.01 : 0.06;
      handle.roof.material.emissiveIntensity = gone ? 0.01 : 0.14;

      // A dead silo stays standing and goes dark — a blackout, not a deletion.
      // The viewer needs to see where it used to be while its grains
      // re-materialise elsewhere.
      handle.drum.material.color.set(dead ? 0x140f0f : silo.crashed ? 0x14121a : 0x0f1926);
      handle.plinth.material.color.set(dead ? 0x120c0c : 0x141d29);

      let bandColour = hslHex(0, 0, 20);
      if (dead) {
        bandColour = 0x3a2626;
      } else if (silo.suspicionVotes > 0) {
        // Pulsing orange: an accusation is on the table but quorum has not
        // been reached, so the silo is still in the cluster.
        const urgency = Math.min(1, silo.suspicionVotes / Math.max(1, silo.votesRequired));
        const pulse = 0.5 + 0.5 * Math.sin(now / 110);
        bandColour = hslHex(38, 95, 45 + urgency * pulse * 25);
      } else {
        bandColour = hue;
      }
      for (const band of handle.bands) {
        band.material.emissive.setHex(bandColour);
        band.material.emissiveIntensity = gone ? 0.06 : silo.suspicionVotes > 0 ? 1.1 : 0.22;
      }
    }
  }

  /** One shelf per registration, wrapped around the registry collar. */
  private stackShelves(handle: BoroughHandle, registrations: number): void {
    const shown = Math.min(registrations, LAYOUT.maxShelves);
    for (let i = 0; i < shown; i++) {
      // Two tiers around the collar, so a full partition wraps rather than
      // climbing away from the structure.
      const tier = Math.floor(i / 17);
      const withinTier = i % 17;
      const angle = (withinTier / 17) * Math.PI * 2;
      this.scratch.position.set(
        handle.center.x + Math.cos(angle) * LAYOUT.galleryRadius,
        LAYOUT.galleryY - 0.6 + tier * LAYOUT.shelfHeight * 1.5,
        handle.center.z + Math.sin(angle) * LAYOUT.galleryRadius,
      );
      this.scratch.rotation.set(0, -angle, 0);
      this.scratch.scale.set(1, 1, 1);
      this.scratch.updateMatrix();
      handle.shelves.setMatrixAt(i, this.scratch.matrix);
    }
    handle.shelves.count = shown;
    handle.shelves.instanceMatrix.needsUpdate = true;
  }

  handleFor(address: SiloAddress): BoroughHandle | undefined {
    return this.handles.get(address);
  }

  pickables(): Mesh[] {
    const meshes: Mesh[] = [];
    for (const handle of this.handles.values()) {
      meshes.push(handle.drum, handle.plinth, handle.collar, handle.roof, handle.dock);
    }
    return meshes;
  }
}
