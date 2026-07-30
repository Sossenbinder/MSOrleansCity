// Town Hall — the cluster membership table.
//
// Deliberately NOT a silo. The silos are tall drums; this is a low, wide,
// colonnaded rotunda, and the contrast is the point: silos are host processes,
// this is shared storage that outlives all of them. Drawing it as another
// tower would suggest it is a peer of theirs, and drawing it inside one would
// suggest failure detection is something a silo does to itself. It is neither.
//
// The ledger is on the OUTSIDE of the building: one illuminated tablet per
// silo, hung between the columns. A membership table with five rows should
// look like five rows, and a suspected row should be visibly different from a
// healthy one — from the plaza, without clicking anything.
//
// Heartbeats and suspicion votes drive here. Peer probes do NOT — those run
// silo to silo. Keeping the two apart on the map is the whole reason this
// building stands on its own.

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { tag } from '../core/inspect';
import { siloColor } from '../core/theme';
import type { SimState } from '../sim/types';
import { LAYOUT } from './layout';

const STONE = 0x9fb0c4;
const ALARMED = 0xff9f43;
const SUSPECT_ROW = 0xff9f43;
const DEAD_ROW = 0x50302f;
const MAX_ROWS = 12;

/** Columns around the rotunda. Also the bays the ledger tablets hang in. */
const COLUMNS = 12;

export class TownHall {
  readonly group = new Group();

  private readonly dome: Mesh<SphereGeometry, MeshStandardMaterial>;
  private readonly beacon: Mesh<CylinderGeometry, MeshStandardMaterial>;
  private readonly rows: InstancedMesh;
  private readonly scratch = new Object3D();
  private readonly rowColour = new Color();
  private readonly radius = LAYOUT.townHallWidth * 0.72;
  private readonly ledgerY: number;

  constructor() {
    const columnHeight = LAYOUT.townHallHeight * 0.42;
    const stepHeight = LAYOUT.townHallHeight * 0.1;

    // -- stylobate -----------------------------------------------------------
    // Two shallow steps, so the building sits ON the ground rather than being
    // dropped through it.
    for (let i = 0; i < 2; i++) {
      const step = new Mesh(
        new CylinderGeometry(
          this.radius * (1.24 - i * 0.08),
          this.radius * (1.3 - i * 0.08),
          stepHeight,
          COLUMNS * 2,
        ),
        new MeshStandardMaterial({ color: 0x18222f, roughness: 0.9, metalness: 0.12 }),
      );
      step.position.set(LAYOUT.townHall.x, stepHeight * (i + 0.5), LAYOUT.townHall.z);
      step.receiveShadow = true;
      step.castShadow = true;
      tag(step, { kind: 'townhall' });
      this.group.add(step);
    }
    const floorY = stepHeight * 2;

    // -- colonnade -----------------------------------------------------------
    for (let i = 0; i < COLUMNS; i++) {
      const angle = (i / COLUMNS) * Math.PI * 2;
      const column = new Mesh(
        new CylinderGeometry(0.55, 0.66, columnHeight, 10),
        new MeshStandardMaterial({
          color: 0x223044,
          emissive: STONE,
          emissiveIntensity: 0.18,
          roughness: 0.65,
          metalness: 0.25,
        }),
      );
      column.position.set(
        LAYOUT.townHall.x + Math.cos(angle) * this.radius,
        floorY + columnHeight / 2,
        LAYOUT.townHall.z + Math.sin(angle) * this.radius,
      );
      column.castShadow = true;
      tag(column, { kind: 'townhall' });
      this.group.add(column);
    }

    // -- entablature and cornice ---------------------------------------------
    const entablature = new Mesh(
      new CylinderGeometry(this.radius * 1.14, this.radius * 1.14, stepHeight * 1.4, COLUMNS * 2),
      new MeshStandardMaterial({
        color: 0x1d2938,
        emissive: STONE,
        emissiveIntensity: 0.22,
        roughness: 0.6,
        metalness: 0.3,
      }),
    );
    entablature.position.set(
      LAYOUT.townHall.x,
      floorY + columnHeight + stepHeight * 0.7,
      LAYOUT.townHall.z,
    );
    entablature.castShadow = true;
    tag(entablature, { kind: 'townhall' });

    // A lit ring at the roofline: catches bloom and gives the building an
    // outline at distance without turning it into a glowing block.
    const cornice = new Mesh(
      new TorusGeometry(this.radius * 1.15, 0.2, 8, COLUMNS * 4),
      new MeshStandardMaterial({ color: STONE, emissive: STONE, emissiveIntensity: 1.1 }),
    );
    cornice.rotation.x = -Math.PI / 2;
    cornice.position.copy(entablature.position);

    // -- dome ----------------------------------------------------------------
    const domeY = floorY + columnHeight + stepHeight * 1.4;
    this.dome = new Mesh(
      new SphereGeometry(this.radius, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2),
      new MeshStandardMaterial({
        color: 0x22303f,
        emissive: STONE,
        emissiveIntensity: 0.5,
        roughness: 0.55,
        metalness: 0.35,
      }),
    );
    this.dome.position.set(LAYOUT.townHall.x, domeY, LAYOUT.townHall.z);
    this.dome.castShadow = true;
    tag(this.dome, { kind: 'townhall' });

    // -- beacon --------------------------------------------------------------
    this.beacon = new Mesh(
      new CylinderGeometry(0.85, 0.85, 4.4, 12),
      new MeshStandardMaterial({
        color: ALARMED,
        emissive: ALARMED,
        emissiveIntensity: 0,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.beacon.position.set(
      LAYOUT.townHall.x,
      domeY + this.radius + 2.0,
      LAYOUT.townHall.z,
    );
    tag(this.beacon, { kind: 'townhall' });

    // -- the ledger ----------------------------------------------------------
    this.rows = new InstancedMesh(
      new BoxGeometry(2.6, 1.5, 0.4),
      new MeshStandardMaterial({ roughness: 0.45, metalness: 0.3 }),
      MAX_ROWS,
    );
    this.rows.frustumCulled = false;
    this.rows.count = 0;
    tag(this.rows, { kind: 'townhall' });

    this.ledgerY = floorY + columnHeight * 0.62;

    this.group.add(entablature, cornice, this.dome, this.beacon, this.rows);
  }

  /** Redraws the ledger: a tablet per silo, coloured by what the table believes. */
  private layOutRows(state: SimState): void {
    const shown = Math.min(state.silos.length, MAX_ROWS);
    for (let i = 0; i < shown; i++) {
      const silo = state.silos[i];
      if (!silo) continue;

      // Spread across the plaza-facing side, so several rows are readable from
      // any one viewpoint rather than most of them hiding round the back.
      const angle = -Math.PI / 2 + ((i + 0.5) / shown - 0.5) * Math.PI * 1.5;
      const reach = this.radius * 1.02;
      this.scratch.position.set(
        LAYOUT.townHall.x + Math.cos(angle) * reach,
        this.ledgerY,
        LAYOUT.townHall.z + Math.sin(angle) * reach,
      );
      this.scratch.rotation.set(0, -angle, 0);
      // Height tracks how many registrations the silo owns, so the ledger also
      // shows the directory spread at a glance.
      this.scratch.scale.set(1, 0.55 + Math.min(1, silo.directoryEntryCount / 22), 1);
      this.scratch.updateMatrix();
      this.rows.setMatrixAt(i, this.scratch.matrix);

      const colour =
        silo.status === 'Dead'
          ? DEAD_ROW
          : silo.suspicionVotes > 0
            ? SUSPECT_ROW
            : siloColor(silo.index, 58);
      this.rows.setColorAt(i, this.rowColour.setHex(colour));
    }

    this.rows.count = shown;
    this.rows.instanceMatrix.needsUpdate = true;
    if (this.rows.instanceColor) this.rows.instanceColor.needsUpdate = true;
  }

  sync(state: SimState): void {
    this.layOutRows(state);
    const votes = state.silos.reduce((sum, silo) => sum + silo.suspicionVotes, 0);
    const anyDead = state.silos.some((silo) => silo.status === 'Dead');

    this.beacon.visible = votes > 0 || anyDead;
    this.beacon.material.emissiveIntensity = votes > 0
      ? 1.6 + 0.8 * Math.sin(state.now / 70)
      : anyDead
        ? 0.5
        : 0;

    this.dome.material.emissiveIntensity = votes > 0 ? 1.1 : 0.5;
  }

  pickables(): Mesh[] {
    return [this.dome, this.beacon, this.rows];
  }
}
