// The Canals — stream delivery.
//
// One pumping station per silo: the pulling agent. Which agent services a
// given stream is decided by hashing the stream id, not by the producer or the
// consumer — neither of them chose it, and neither knows about it. That is the
// point of the district. A stream is not a pipe between two grains; it is a
// name that some agent is responsible for draining.
//
// The canal ring links the stations because delivery is cluster-wide
// infrastructure, not a per-borough concern.

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  TorusGeometry,
} from 'three';
import { tag } from '../core/inspect';
import type { SiloAddress, SimState } from '../sim/types';
import { LAYOUT, pullingAgentAnchor } from './layout';

const WATER = 0x6ad4ff;

export class Canals {
  readonly group = new Group();

  private readonly stations = new Map<SiloAddress, Mesh<BoxGeometry, MeshStandardMaterial>>();
  private readonly spouts = new Map<SiloAddress, Mesh<CylinderGeometry, MeshBasicMaterial>>();

  constructor(silos: readonly { address: SiloAddress; index: number }[]) {
    const count = silos.length;

    // The canal itself: a ring passing through every station.
    const canalRadius = Math.hypot(LAYOUT.boroughOrbit, LAYOUT.agentOffset);
    const canal = new Mesh(
      new TorusGeometry(canalRadius, 0.28, 8, 120),
      new MeshBasicMaterial({ color: WATER, transparent: true, opacity: 0.28 }),
    );
    canal.rotation.x = -Math.PI / 2;
    canal.position.y = LAYOUT.plinthHeight * 0.5;
    this.group.add(canal);

    for (const silo of silos) {
      const anchor = pullingAgentAnchor(silo.index, count);

      const station = new Mesh(
        new BoxGeometry(2.1, LAYOUT.agentHeight, 2.1),
        new MeshStandardMaterial({
          color: 0x2a4a5e,
          emissive: WATER,
          emissiveIntensity: 0.1,
          roughness: 0.6,
          metalness: 0.25,
        }),
      );
      station.position.copy(anchor);
      station.castShadow = true;
      tag(station, { kind: 'pullingagent', silo: silo.address });

      // Lights up while this agent actually owns a stream.
      const spout = new Mesh(
        new CylinderGeometry(0.32, 0.32, 2.6, 8),
        new MeshBasicMaterial({ color: WATER, transparent: true, opacity: 0 }),
      );
      spout.position.set(anchor.x, anchor.y + LAYOUT.agentHeight * 0.9, anchor.z);
      tag(spout, { kind: 'pullingagent', silo: silo.address });

      this.stations.set(silo.address, station);
      this.spouts.set(silo.address, spout);
      this.group.add(station, spout);
    }
  }

  sync(state: SimState): void {
    const owned = new Map<SiloAddress, number>();
    for (const stream of state.streams) {
      if (!stream.agentSilo) continue;
      owned.set(stream.agentSilo, (owned.get(stream.agentSilo) ?? 0) + 1);
    }

    for (const [address, station] of this.stations) {
      const dead = state.silos.find((s) => s.address === address)?.status === 'Dead';
      const streams = owned.get(address) ?? 0;
      station.material.emissiveIntensity = dead ? 0 : 0.1 + Math.min(0.6, streams * 0.25);
      station.visible = !dead;

      const spout = this.spouts.get(address);
      if (!spout) continue;
      spout.visible = !dead && streams > 0;
      spout.material.opacity =
        streams > 0 ? 0.35 + 0.25 * Math.sin(state.now / 120 + address.length) : 0;
    }
  }

  pickables(): Mesh[] {
    return [...this.stations.values(), ...this.spouts.values()];
  }
}
