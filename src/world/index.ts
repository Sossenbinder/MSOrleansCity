// world/ — the city geometry.
//
// The City owns every object in the scene and rebuilds nothing it does not
// have to. Its one public verb is sync(state): read the snapshot, make the
// geometry agree with it. world/ NEVER calls back into sim/ (outline:
// structural rule #2) — if the city wants something to change, it can only
// render what the next snapshot says.

import {
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  RingGeometry,
  Vector3,
} from 'three';
import { tag } from '../core/inspect';
import { PALETTE } from '../core/theme';
import type { SiloAddress, SimState } from '../sim/types';
import { Boroughs } from './boroughs';
import { Buildings } from './buildings';
import { Canals } from './canals';
import { ClockTower } from './clockTower';
import { Labels, type LabelSpec } from './labels';
import { LAYOUT, boroughCenter } from './layout';
import { RingRoad } from './ringRoad';
import { Streets } from './streets';
import { TownHall } from './townHall';
import { Vault } from './vault';

export * from './layout';
export { Boroughs } from './boroughs';
export { Buildings } from './buildings';
export { Canals } from './canals';
export { ClockTower } from './clockTower';
export { Labels } from './labels';
export { RingRoad } from './ringRoad';
export { Streets } from './streets';
export { TownHall } from './townHall';
export { Vault } from './vault';

export class City {
  readonly group = new Group();

  readonly boroughs: Boroughs;
  readonly ringRoad: RingRoad;
  readonly buildings: Buildings;
  readonly townHall: TownHall;
  readonly vault: Vault;
  readonly clockTower: ClockTower;
  readonly canals: Canals;
  readonly streets: Streets;
  readonly labels: Labels;

  private readonly siloIndex = new Map<SiloAddress, number>();
  private readonly siloCount: number;
  private readonly client: Mesh;
  private ringSignature = '';

  constructor(initial: SimState) {
    this.siloCount = initial.silos.length;
    for (const silo of initial.silos) this.siloIndex.set(silo.address, silo.index);

    // The ground is a ring, not a disc: the hole is the vault excavation, and
    // without it the plaza floor would hide the district entirely.
    const ground = new Mesh(
      new RingGeometry(LAYOUT.vaultRadius, LAYOUT.groundSize / 2, 96, 1),
      new MeshStandardMaterial({
        color: 0x0c141f,
        emissive: 0x0a1522,
        emissiveIntensity: 0.5,
        roughness: 1,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;

    this.boroughs = new Boroughs(initial.silos);
    this.ringRoad = new RingRoad();
    this.buildings = new Buildings(
      (silo) => this.indexOf(silo),
      this.siloCount,
      initial.silos,
    );
    this.townHall = new TownHall();
    this.vault = new Vault();
    this.clockTower = new ClockTower();
    this.canals = new Canals(initial.silos);
    this.streets = new Streets(this.siloCount);
    this.labels = new Labels(this.labelSpecs(initial));

    // The client sits above and north of the city: calls arrive from outside
    // the cluster, which is exactly where clients live.
    this.client = new Mesh(
      new OctahedronGeometry(2.4),
      new MeshStandardMaterial({
        color: PALETTE.clientSky,
        emissive: PALETTE.clientSky,
        emissiveIntensity: 0.25,
        roughness: 0.4,
      }),
    );
    this.client.position.copy(LAYOUT.clientAnchor);
    tag(this.client, { kind: 'client' });

    this.group.add(
      ground,
      this.streets.group,
      this.ringRoad.group,
      this.canals.group,
      this.boroughs.group,
      this.buildings.group,
      this.townHall.group,
      this.vault.group,
      this.clockTower.group,
      this.client,
      this.labels.group,
    );
  }

  private labelSpecs(initial: SimState): LabelSpec[] {
    const specs: LabelSpec[] = [
      // Label heights are staggered deliberately: districts at different
      // depths otherwise land at the same screen height and overlap.
      {
        text: 'Town Hall',
        sub: 'membership table',
        at: LAYOUT.townHall.clone().setY(LAYOUT.townHallHeight + 8),
        color: '#c7d3e4',
      },
      {
        text: 'Clock Tower',
        sub: 'durable reminders',
        at: LAYOUT.clockTower.clone().setY(LAYOUT.clockTowerHeight + 9),
        color: '#ffd166',
      },
      {
        text: 'The Vault',
        sub: 'grain storage · ETags',
        at: new Vector3(LAYOUT.vault.x + LAYOUT.vaultRadius + 10, 2, LAYOUT.vault.z),
        color: '#4fd1c5',
      },
      {
        text: 'Ring road',
        sub: 'consistent hash ring',
        at: new Vector3(0, LAYOUT.ringDeckY + 6, LAYOUT.ringRadius + 12),
        color: '#9fb0c4',
      },
      {
        text: 'Clients',
        sub: 'outside the cluster',
        at: LAYOUT.clientAnchor.clone().setY(LAYOUT.clientAnchor.y + 7),
        color: '#e6edf6',
      },
    ];

    for (const silo of initial.silos) {
      specs.push({
        text: `Silo ${silo.index + 1}`,
        sub: silo.address,
        at: boroughCenter(silo.index, initial.silos.length).setY(
          LAYOUT.plinthHeight + LAYOUT.siloHeight + LAYOUT.roofHeight + 8,
        ),
        color: '#b6c3d4',
      });
    }
    return specs;
  }

  indexOf(silo: SiloAddress): number {
    return this.siloIndex.get(silo) ?? 0;
  }

  sync(state: SimState): void {
    this.boroughs.sync(state.silos, state.now);
    this.buildings.sync(state.activations, state.now);
    this.townHall.sync(state);
    this.vault.sync(state);
    this.clockTower.sync(state);
    this.canals.sync(state);
    this.ringRoad.syncTicks(state.activations);

    // Ring arcs only change on membership change, so avoid rebuilding tube
    // geometry every frame.
    const signature = state.ring.map((a) => `${a.silo}:${a.start.toFixed(6)}`).join('|');
    if (signature !== this.ringSignature) {
      this.ringSignature = signature;
      this.ringRoad.sync(state.ring, (silo) => this.indexOf(silo));
    }
  }

  pickables(): Mesh[] {
    return [
      ...this.boroughs.pickables(),
      ...this.buildings.pickables(),
      ...this.ringRoad.pickables(),
      ...this.townHall.pickables(),
      ...this.vault.pickables(),
      ...this.clockTower.pickables(),
      ...this.canals.pickables(),
      this.client,
    ];
  }
}
