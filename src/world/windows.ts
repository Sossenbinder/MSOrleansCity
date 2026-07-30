// The window texture.
//
// A grain activation drawn as a flat-shaded box is a box. The same box with
// rows of lit windows is a building, and the difference costs one shared
// canvas. Combined with bloom this is what makes the boroughs read as a city
// at night rather than as a bar chart.
//
// The texture is generated once and shared; each building clones it only to
// set its own repeat, so a tall building shows more floors instead of
// stretching the same windows.

import { CanvasTexture, NearestFilter, RepeatWrapping, type Texture } from 'three';

const TILE = 64;
const COLS = 4;
const ROWS = 4;

let cached: CanvasTexture | undefined;

/** One tile = one floor of one facade, with some windows dark. */
function draw(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TILE;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, TILE, TILE);

    const pad = 3;
    const cellW = TILE / COLS;
    const cellH = TILE / ROWS;

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        // A deterministic scatter of dark windows. A fully lit facade looks
        // like a lightbox; a few dark panes make it look occupied.
        const lit = (row * 7 + col * 3 + ((row * col) % 5)) % 4 !== 0;
        if (!lit) continue;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(
          col * cellW + pad,
          row * cellH + pad,
          cellW - pad * 2,
          cellH - pad * 2,
        );
      }
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  // Crisp panes rather than a blurred smear when the camera pulls back.
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

export function windowTexture(): CanvasTexture {
  cached ??= draw();
  return cached;
}

/** A per-building clone that shares the image but owns its repeat. */
export function windowTextureFor(floors: number): Texture {
  const texture = windowTexture().clone();
  texture.needsUpdate = true;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(1, Math.max(1, Math.round(floors)));
  return texture;
}
