// In-world district labels.
//
// Without these the city is a set of shapes you have to click to identify.
// A label per district means the map is readable at a glance and the inspector
// becomes the second step rather than the only one.
//
// Drawn as canvas-textured sprites: always facing the camera, no extra
// renderer, no DOM overlay to keep in sync with the 3D scene.

import { CanvasTexture, Group, Sprite, SpriteMaterial, Vector3 } from 'three';

interface LabelSpec {
  readonly text: string;
  readonly sub: string;
  readonly at: Vector3;
  readonly color: string;
}

function makeSprite(spec: LabelSpec): Sprite {
  const scale = 2; // supersample so text stays crisp when zoomed
  const width = 512;
  const height = 128;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;

  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(scale, scale);
    ctx.clearRect(0, 0, width, height);

    ctx.font = '600 42px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = spec.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.text, width / 2, 42);

    ctx.font = '26px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(150, 168, 192, 0.75)';
    ctx.fillText(spec.sub, width / 2, 86);
  }

  const texture = new CanvasTexture(canvas);
  const sprite = new Sprite(
    new SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  sprite.scale.set(26, 6.5, 1);
  sprite.position.copy(spec.at);
  // Draw after the city so labels are never buried inside geometry.
  sprite.renderOrder = 10;
  return sprite;
}

export class Labels {
  readonly group = new Group();

  constructor(specs: readonly LabelSpec[]) {
    for (const spec of specs) this.group.add(makeSprite(spec));
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }
}

export type { LabelSpec };
