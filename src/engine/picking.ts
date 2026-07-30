// Picking — turning a click into an Inspectable.
//
// Only objects tagged in core/inspect.ts are pickable, so adding scenery never
// accidentally makes it clickable. A drag is not a click: the camera is
// orbited by dragging, and firing the inspector every time someone rotates the
// view would be maddening.

import { Camera, Object3D, Raycaster, Vector2 } from 'three';
import { readTag, type Inspectable } from '../core/inspect';

const DRAG_THRESHOLD_PX = 5;

export class Picker {
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private downAt: { x: number; y: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly targets: () => Object3D[],
  ) {}

  onPick(handler: (picked: Inspectable | undefined) => void): () => void {
    const onDown = (event: PointerEvent): void => {
      this.downAt = { x: event.clientX, y: event.clientY };
    };

    const onUp = (event: PointerEvent): void => {
      const start = this.downAt;
      this.downAt = null;
      if (!start) return;
      const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (moved > DRAG_THRESHOLD_PX) return;
      handler(this.pickAt(event.clientX, event.clientY));
    };

    this.canvas.addEventListener('pointerdown', onDown);
    this.canvas.addEventListener('pointerup', onUp);
    return () => {
      this.canvas.removeEventListener('pointerdown', onDown);
      this.canvas.removeEventListener('pointerup', onUp);
    };
  }

  onHover(handler: (hovered: Inspectable | undefined) => void): () => void {
    const onMove = (event: PointerEvent): void => {
      handler(this.pickAt(event.clientX, event.clientY));
    };
    this.canvas.addEventListener('pointermove', onMove);
    return () => this.canvas.removeEventListener('pointermove', onMove);
  }

  pickAt(clientX: number, clientY: number): Inspectable | undefined {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    for (const hit of this.raycaster.intersectObjects(this.targets(), false)) {
      const tag = readTag(hit.object.userData);
      if (tag) return tag;
    }
    return undefined;
  }
}
