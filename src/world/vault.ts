// The Vault — grain storage, excavated under the plaza.
//
// Below ground because it is the one thing in the city that outlives
// everything above it. Buildings rise and are demolished constantly; what a
// grain wrote to the vault survives all of that, and survives the silo dying
// too. The shelves stack up as versions accumulate.
//
// It is deliberately a trip: a persistent grain cannot take its first turn
// until it has been down here and back, which is why those buildings take
// visibly longer to come up.

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  TorusGeometry,
} from 'three';
import { tag } from '../core/inspect';
import type { SimState } from '../sim/types';
import { LAYOUT } from './layout';

const VAULT_COLOR = 0x2fb3a8;
const MAX_SHELVES = 7;
const MAX_CELLS = 256;
const CELL_GRID = 16;
const CELL_PITCH = 1.6;

export class Vault {
  readonly group = new Group();

  private readonly floor: Mesh<CylinderGeometry, MeshStandardMaterial>;
  private readonly shelves: Mesh<TorusGeometry, MeshStandardMaterial>[] = [];
  private readonly cells: InstancedMesh;
  private readonly scratch = new Object3D();

  constructor() {
    // The shaft wall, open at the top so you can see down into it.
    const shaft = new Mesh(
      new CylinderGeometry(LAYOUT.vaultRadius, LAYOUT.vaultRadius * 0.86, LAYOUT.vaultDepth, 40, 1, true),
      new MeshStandardMaterial({
        color: 0x16202b,
        roughness: 0.95,
        side: 2, // DoubleSide — we are looking at it from inside
      }),
    );
    shaft.position.set(LAYOUT.vault.x, -LAYOUT.vaultDepth / 2, LAYOUT.vault.z);
    tag(shaft, { kind: 'vault' });

    this.floor = new Mesh(
      new CylinderGeometry(LAYOUT.vaultRadius * 0.86, LAYOUT.vaultRadius * 0.86, 0.6, 40),
      new MeshStandardMaterial({
        color: VAULT_COLOR,
        emissive: VAULT_COLOR,
        emissiveIntensity: 0.12,
        roughness: 0.5,
        metalness: 0.4,
      }),
    );
    this.floor.position.set(LAYOUT.vault.x, -LAYOUT.vaultDepth, LAYOUT.vault.z);
    tag(this.floor, { kind: 'vault' });

    // A lip at ground level. Without it the pit reads as a flat coloured disc
    // painted on the plaza rather than a hole you are looking down into.
    const lip = new Mesh(
      new TorusGeometry(LAYOUT.vaultRadius, 0.55, 8, 72),
      new MeshStandardMaterial({
        color: 0x35435a,
        emissive: VAULT_COLOR,
        emissiveIntensity: 0.12,
        roughness: 0.8,
      }),
    );
    lip.rotation.x = -Math.PI / 2;
    lip.position.set(LAYOUT.vault.x, 0, LAYOUT.vault.z);
    tag(lip, { kind: 'vault' });

    this.group.add(shaft, this.floor, lip);

    // One cell per stored grain, laid out on the vault floor. Cell height is
    // that grain's version count, so you can see which rows are being written
    // repeatedly and which were written once and left alone.
    this.cells = new InstancedMesh(
      new BoxGeometry(1.05, 1, 1.05),
      new MeshStandardMaterial({
        color: 0x7be3d8,
        emissive: 0x2fb3a8,
        emissiveIntensity: 0.35,
        roughness: 0.4,
        metalness: 0.3,
      }),
      MAX_CELLS,
    );
    this.cells.frustumCulled = false;
    this.cells.count = 0;
    this.group.add(this.cells);

    // Galleries: full-width rings stepping down the shaft. They give the pit a
    // readable depth — without them you cannot tell a deep excavation from a
    // shallow dish painted on the plaza.
    for (let i = 0; i < LAYOUT.vaultGalleries; i++) {
      const t = (i + 1) / (LAYOUT.vaultGalleries + 1);
      const gallery = new Mesh(
        new TorusGeometry(LAYOUT.vaultRadius * (1 - t * 0.2), 0.55, 8, 64),
        new MeshStandardMaterial({
          color: 0x1d3038,
          emissive: VAULT_COLOR,
          emissiveIntensity: 0.22,
          roughness: 0.7,
          metalness: 0.3,
        }),
      );
      gallery.rotation.x = -Math.PI / 2;
      gallery.position.set(LAYOUT.vault.x, -LAYOUT.vaultDepth * t, LAYOUT.vault.z);
      tag(gallery, { kind: 'vault' });
      this.group.add(gallery);
    }

    // Shelves: one ring per band of stored versions. Hidden until earned, so
    // an empty vault looks empty.
    for (let i = 0; i < MAX_SHELVES; i++) {
      const radius = LAYOUT.vaultRadius * (0.3 + 0.075 * i);
      const shelf = new Mesh(
        new TorusGeometry(radius, 0.34, 8, 44),
        new MeshStandardMaterial({
          color: VAULT_COLOR,
          emissive: VAULT_COLOR,
          emissiveIntensity: 0.45,
          transparent: true,
          opacity: 0.8,
        }),
      );
      shelf.rotation.x = -Math.PI / 2;
      shelf.position.set(
        LAYOUT.vault.x,
        -LAYOUT.vaultDepth + 1.4 + i * 1.5,
        LAYOUT.vault.z,
      );
      shelf.visible = false;
      tag(shelf, { kind: 'vault' });
      this.shelves.push(shelf);
      this.group.add(shelf);
    }
  }

  sync(state: SimState): void {
    this.layOutCells(state);
    const versions = state.vault.totalVersions;
    const earned = Math.min(MAX_SHELVES, Math.ceil(versions / 3));
    this.shelves.forEach((shelf, i) => {
      shelf.visible = i < earned;
    });

    // A conflict is the interesting event down here: a writer arrived with a
    // stale ETag and was turned away.
    const alarmed = state.vault.conflicts > 0;
    this.floor.material.emissiveIntensity = alarmed
      ? 0.4 + 0.3 * Math.sin(state.now / 80)
      : 0.12 + Math.min(0.25, versions * 0.01);
    this.floor.material.color.set(alarmed ? 0xff7b5c : VAULT_COLOR);
  }

  /** A cell per stored grain; its height is that grain's version count. */
  private layOutCells(state: SimState): void {
    const entries = state.vault.entries.slice(0, MAX_CELLS);
    const span = (CELL_GRID - 1) * CELL_PITCH;

    entries.forEach((entry, i) => {
      const col = i % CELL_GRID;
      const row = Math.floor(i / CELL_GRID);
      const height = Math.min(6, 0.8 + entry.version * 0.4);
      this.scratch.position.set(
        LAYOUT.vault.x + col * CELL_PITCH - span / 2,
        -LAYOUT.vaultDepth + 0.5 + height / 2,
        LAYOUT.vault.z + row * CELL_PITCH - span / 2,
      );
      this.scratch.rotation.set(0, 0, 0);
      this.scratch.scale.set(1, height, 1);
      this.scratch.updateMatrix();
      this.cells.setMatrixAt(i, this.scratch.matrix);
    });

    this.cells.count = entries.length;
    this.cells.instanceMatrix.needsUpdate = true;
  }

  pickables(): Mesh[] {
    return [this.floor, ...this.shelves];
  }
}
