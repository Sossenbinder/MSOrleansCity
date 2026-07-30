// Flows — the vehicles.
//
// One mesh per in-flight message, positioned along an arc between its two
// anchors at the progress the simulation reports. Meshes are pooled: message
// traffic is bursty, and allocating a sphere per hop would churn badly during
// a storm scenario.
//
// The route itself is computed by world/layout.ts. engine/ only asks for the
// curve and puts an object on it (outline: structural rule #1).

import { Color, Group, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import { tag } from '../core/inspect';
import { MESSAGE_COLORS, MUTED_MESSAGE_KINDS } from '../core/theme';
import type { InFlightView, NodeRef, SiloAddress } from '../sim/types';
import { anchorFor, routeCurve } from '../world/layout';

const VEHICLE_RADIUS = 0.62;

export interface FlowContext {
  indexOf(silo: SiloAddress): number;
  siloCount: number;
  slotOf(silo: SiloAddress, grainId: string): number | undefined;
}

export class Flows {
  readonly group = new Group();

  private readonly pool: Mesh<SphereGeometry, MeshBasicMaterial>[] = [];
  private readonly geometry = new SphereGeometry(VEHICLE_RADIUS, 10, 8);
  private visibleCount = 0;

  constructor(private readonly context: FlowContext) {}

  private acquire(index: number): Mesh<SphereGeometry, MeshBasicMaterial> {
    const existing = this.pool[index];
    if (existing) return existing;
    const mesh = new Mesh(
      this.geometry,
      new MeshBasicMaterial({ color: new Color(0xffffff), transparent: true, opacity: 0.85 }),
    );
    this.pool[index] = mesh;
    this.group.add(mesh);
    return mesh;
  }

  private anchor(node: NodeRef): Vector3 {
    return anchorFor(
      node,
      (silo) => this.context.indexOf(silo),
      this.context.siloCount,
      (silo, grainId) => this.context.slotOf(silo, grainId),
    );
  }

  sync(inFlight: readonly InFlightView[]): void {
    inFlight.forEach((message, i) => {
      const mesh = this.acquire(i);
      const curve = routeCurve(this.anchor(message.from), this.anchor(message.to));
      curve.getPoint(message.progress, mesh.position);
      mesh.material.color.set(MESSAGE_COLORS[message.kind] ?? 0xffffff);
      // Heartbeats and probes are constant background traffic. Drawn small and
      // dim so they read as a pulse the city has, rather than competing with
      // request flow for the viewer's attention.
      const muted = MUTED_MESSAGE_KINDS.has(message.kind);
      mesh.scale.setScalar(muted ? 0.45 : 1);
      mesh.material.opacity = muted ? 0.42 : 0.85;
      mesh.visible = true;
      // Re-tagged every frame: the pool reuses meshes, so a given sphere is a
      // different message from one frame to the next.
      tag(mesh, { kind: 'message', id: message.id });
    });

    for (let i = inFlight.length; i < this.pool.length; i++) {
      const mesh = this.pool[i];
      if (mesh) mesh.visible = false;
    }
    this.visibleCount = inFlight.length;
  }

  /** Only the meshes currently carrying a message are pickable. */
  pickables(): Mesh[] {
    return this.pool.slice(0, this.visibleCount);
  }

  dispose(): void {
    for (const mesh of this.pool) {
      mesh.material.dispose();
      this.group.remove(mesh);
    }
    this.pool.length = 0;
    this.geometry.dispose();
  }
}
