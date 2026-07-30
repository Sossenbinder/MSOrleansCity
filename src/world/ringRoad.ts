// The ring road — the consistent hash ring, drawn at city scale.
//
// The grey torus is the ring itself. The coloured segments laid over it are
// directory partitions: each arc is painted in the hue of the silo that owns
// it, so "which borough answers for this grain" is a thing you can see rather
// than a thing you have to be told.
//
// When membership changes, arcs are rebuilt and visibly hand over — which is
// the whole reason the directory survives a silo loss without a full reshuffle.

import {
  BoxGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  TorusGeometry,
  TubeGeometry,
} from 'three';
import { tag } from '../core/inspect';
import { PALETTE, siloColor } from '../core/theme';
import { ringPosition } from '../sim/hash';
import type { ActivationView, RingArc, SiloAddress } from '../sim/types';
import { LAYOUT, ringArcPoints, ringPoint } from './layout';

const MAX_TICKS = 400;

export class RingRoad {
  readonly group = new Group();
  private readonly arcGroup = new Group();
  private readonly road: Mesh;

  /**
   * One tick per live grain, standing at its own hash position on the ring.
   *
   * This is what makes the ring concrete rather than a diagram: you can see
   * where each grain lands, see the arcs that own them, and see how unevenly
   * hashing distributes when a silo has only one position on the ring.
   */
  private readonly ticks: InstancedMesh;
  private readonly scratch = new Object3D();

  constructor() {
    // An elevated viaduct rather than a line painted on the floor. Raising it
    // and putting it on pillars is what turns the ring from a diagram
    // annotation into a piece of infrastructure you could walk under.
    this.road = new Mesh(
      new TorusGeometry(LAYOUT.ringRadius, LAYOUT.ringTube, 16, 180),
      new MeshStandardMaterial({ color: PALETTE.ringRoad, roughness: 0.9, metalness: 0.25 }),
    );
    this.road.rotation.x = -Math.PI / 2;
    this.road.position.y = LAYOUT.ringDeckY;
    this.road.castShadow = true;
    tag(this.road, { kind: 'ring' });

    // Pillars down to the ground at regular intervals. The repetition is the
    // scale cue: you read the size of the ring off the spacing.
    const pillars = new InstancedMesh(
      new CylinderGeometry(LAYOUT.ringPillarWidth * 0.5, LAYOUT.ringPillarWidth, LAYOUT.ringDeckY, 6),
      new MeshStandardMaterial({ color: 0x1a2431, roughness: 0.9, metalness: 0.2 }),
      LAYOUT.ringPillarEvery * 4,
    );
    pillars.frustumCulled = false;
    let pillarIndex = 0;
    const pillarCount = LAYOUT.ringPillarEvery * 4;
    for (let i = 0; i < pillarCount; i++) {
      const at = ringPoint(i / pillarCount, LAYOUT.ringDeckY / 2);
      this.scratch.position.copy(at);
      this.scratch.rotation.set(0, 0, 0);
      this.scratch.scale.set(1, 1, 1);
      this.scratch.updateMatrix();
      pillars.setMatrixAt(pillarIndex++, this.scratch.matrix);
    }
    pillars.count = pillarIndex;
    pillars.instanceMatrix.needsUpdate = true;
    this.group.add(pillars);

    this.ticks = new InstancedMesh(
      new BoxGeometry(0.3, 2.6, 0.3),
      new MeshBasicMaterial({ color: 0x8fa4bd, transparent: true, opacity: 0.75 }),
      MAX_TICKS,
    );
    this.ticks.frustumCulled = false;
    this.ticks.count = 0;

    this.group.add(this.road, this.arcGroup, this.ticks);
  }

  /** Plants a tick on the ring at each live grain's hash position. */
  syncTicks(activations: readonly ActivationView[]): void {
    const shown = Math.min(activations.length, MAX_TICKS);
    for (let i = 0; i < shown; i++) {
      const grainId = activations[i]?.address.grainId;
      if (grainId === undefined) continue;
      const at = ringPoint(ringPosition(grainId), LAYOUT.ringDeckY + 1.7);
      this.scratch.position.copy(at);
      this.scratch.rotation.set(0, 0, 0);
      this.scratch.scale.set(1, 1, 1);
      this.scratch.updateMatrix();
      this.ticks.setMatrixAt(i, this.scratch.matrix);
    }
    this.ticks.count = shown;
    this.ticks.instanceMatrix.needsUpdate = true;
  }

  /**
   * Rebuilds the ownership arcs. Cheap enough to redo whenever membership
   * changes, and membership changes are rare — no incremental diffing needed.
   */
  sync(arcs: readonly RingArc[], indexOf: (silo: SiloAddress) => number): void {
    for (const child of [...this.arcGroup.children]) {
      this.arcGroup.remove(child);
      if (child instanceof Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    }

    for (const arc of arcs) {
      const points = ringArcPoints(arc.start, arc.end);
      if (points.length < 2) continue;
      const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.2);
      const mesh = new Mesh(
        new TubeGeometry(curve, Math.max(8, points.length), LAYOUT.ringTube * 0.85, 8, false),
        new MeshBasicMaterial({
          color: siloColor(indexOf(arc.silo), 42),
          transparent: true,
          opacity: 0.9,
        }),
      );
      tag(mesh, { kind: 'ring' });
      this.arcGroup.add(mesh);
    }
  }

  pickables(): Mesh[] {
    return [this.road, ...this.arcGroup.children.filter((c): c is Mesh => c instanceof Mesh)];
  }
}
