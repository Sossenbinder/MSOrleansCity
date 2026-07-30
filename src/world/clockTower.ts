// The Clock Tower — durable reminders.
//
// A landmark on purpose. Reminders are the only mechanism in Orleans that can
// wake a grain nobody is calling: they are stored outside the cluster, they
// survive deactivation and silo failure, and delivering one ACTIVATES the
// target grain. A timer can do none of that — it is in-memory, dies with its
// activation, and is not represented here at all.
//
// The tower fires visibly, and its traffic goes straight to a silo rather than
// through the Town Hall, because reminders and membership are unrelated
// services that merely happen to both live outside any silo.

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  TorusGeometry,
} from 'three';
import { tag } from '../core/inspect';
import type { SimState } from '../sim/types';
import { LAYOUT } from './layout';

const STONE = 0x8d93a8;
const FACE = 0xffd166;

export class ClockTower {
  readonly group = new Group();

  private readonly face: Mesh<TorusGeometry, MeshStandardMaterial>;
  private readonly hand: Mesh<BoxGeometry, MeshStandardMaterial>;
  private readonly beacon: Mesh<CylinderGeometry, MeshStandardMaterial>;
  private lastFiredCount = 0;
  private flashUntil = 0;

  constructor() {
    // Tapering, and tall enough to be a horizon reference from anywhere in the
    // city — which is the point of a clock tower.
    const shaft = new Mesh(
      new CylinderGeometry(
        LAYOUT.clockTowerWidth * 0.42,
        LAYOUT.clockTowerWidth,
        LAYOUT.clockTowerHeight,
        8,
      ),
      new MeshStandardMaterial({
        color: 0x232c3d,
        emissive: STONE,
        emissiveIntensity: 0.1,
        roughness: 0.7,
        metalness: 0.25,
      }),
    );
    shaft.position.set(
      LAYOUT.clockTower.x,
      LAYOUT.clockTowerHeight / 2,
      LAYOUT.clockTower.z,
    );
    shaft.castShadow = true;
    tag(shaft, { kind: 'clocktower' });

    this.face = new Mesh(
      new TorusGeometry(3.6, 0.46, 8, 36),
      new MeshStandardMaterial({
        color: FACE,
        emissive: FACE,
        emissiveIntensity: 0.4,
      }),
    );
    this.face.position.set(
      LAYOUT.clockTower.x,
      LAYOUT.clockTowerHeight * 0.86,
      LAYOUT.clockTower.z - LAYOUT.clockTowerWidth * 0.55,
    );
    tag(this.face, { kind: 'clocktower' });

    // The hand sweeps in proportion to the next reminder's period, so the
    // tower is a live countdown rather than decoration.
    this.hand = new Mesh(
      new BoxGeometry(0.36, 3.0, 0.36),
      new MeshStandardMaterial({ color: 0x1b2430, roughness: 0.6 }),
    );
    this.hand.position.copy(this.face.position);
    this.hand.position.z += 0.35;

    this.beacon = new Mesh(
      new CylinderGeometry(1.0, 1.0, 4.0, 10),
      new MeshStandardMaterial({
        color: FACE,
        emissive: FACE,
        emissiveIntensity: 0,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.beacon.position.set(
      LAYOUT.clockTower.x,
      LAYOUT.clockTowerHeight + 2.2,
      LAYOUT.clockTower.z,
    );

    this.group.add(shaft, this.face, this.hand, this.beacon);
  }

  sync(state: SimState): void {
    const reminders = state.reminders;
    this.face.material.emissiveIntensity = reminders.length > 0 ? 0.55 : 0.16;

    if (reminders.length === 0) {
      this.hand.visible = false;
      this.beacon.material.emissiveIntensity = 0;
      return;
    }
    this.hand.visible = true;

    // Sweep against whichever reminder fires next.
    const next = reminders.reduce((soonest, r) =>
      r.nextFireAt < soonest.nextFireAt ? r : soonest,
    );
    const remaining = Math.max(0, next.nextFireAt - state.now);
    const fraction = next.periodMs > 0 ? 1 - remaining / next.periodMs : 0;
    const angle = fraction * Math.PI * 2;
    this.hand.rotation.z = -angle;
    this.hand.position.x = LAYOUT.clockTower.x + Math.sin(angle) * 1.6;
    this.hand.position.y = LAYOUT.clockTowerHeight * 0.86 + Math.cos(angle) * 1.6;

    const totalFired = reminders.reduce((sum, r) => sum + r.firedCount, 0);
    if (totalFired > this.lastFiredCount) {
      this.lastFiredCount = totalFired;
      this.flashUntil = state.now + 1_200;
    }
    this.beacon.material.emissiveIntensity =
      state.now < this.flashUntil ? 0.9 + 0.4 * Math.sin(state.now / 60) : 0.05;
  }

  pickables(): Mesh[] {
    return [this.face, this.beacon, ...this.group.children.filter((c): c is Mesh => c instanceof Mesh)];
  }
}
