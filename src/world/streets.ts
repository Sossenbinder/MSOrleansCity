// Streets.
//
// Without roads the districts are islands floating on a black plane, and the
// vehicles arcing between them have no visible relationship to the ground.
// Streets do two jobs at once: they make the layout read as a place, and they
// show that the boroughs, the registry ring and the outlying services are all
// connected infrastructure rather than separate diagrams.
//
// Drawn as flat emissive strips just above the ground so they catch bloom and
// glow faintly, the way lit roads do from the air.

import {
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import { LAYOUT, boroughCenter, boroughAngle } from './layout';

const ROAD_COLOR = 0x2b3b52;
const ROAD_GLOW = 0x4a6a95;

/** A flat strip from `from` to `to`, lying on the ground plane. */
function strip(from: Vector3, to: Vector3, width: number, color: number, opacity: number): Mesh {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);

  const mesh = new Mesh(
    new PlaneGeometry(width, length),
    new MeshBasicMaterial({ color, transparent: true, opacity }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = -Math.atan2(dx, dz);
  mesh.position.set((from.x + to.x) / 2, 0.03, (from.z + to.z) / 2);
  return mesh;
}

export class Streets {
  readonly group = new Group();

  constructor(siloCount: number) {
    for (let i = 0; i < siloCount; i++) {
      const center = boroughCenter(i, siloCount);
      const angle = boroughAngle(i, siloCount);

      // Borough out to the ring road: the route directory traffic takes.
      const outer = new Vector3(
        Math.cos(angle) * LAYOUT.ringRadius,
        0,
        Math.sin(angle) * LAYOUT.ringRadius,
      );
      this.group.add(strip(center, outer, 4.2, ROAD_COLOR, 0.85));
      this.group.add(strip(center, outer, 0.42, ROAD_GLOW, 0.55));

      // Silo in to the plaza rim, where the Town Hall stands over the vault.
      const inner = new Vector3(
        Math.cos(angle) * (LAYOUT.vaultRadius + 1.5),
        0,
        Math.sin(angle) * (LAYOUT.vaultRadius + 1.5),
      );
      this.group.add(strip(center, inner, 4.0, ROAD_COLOR, 0.75));
      this.group.add(strip(center, inner, 0.4, ROAD_GLOW, 0.4));
    }

    // Approach road to the Clock Tower, which sits outside the ring.
    this.group.add(
      strip(
        new Vector3(LAYOUT.ringRadius * 0.62, 0, -LAYOUT.ringRadius * 0.34),
        LAYOUT.clockTower.clone(),
        3.2,
        ROAD_COLOR,
        0.55,
      ),
    );
  }
}
