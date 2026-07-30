// Sky and atmosphere.
//
// A flat black background makes everything read as a diagram floating in
// nothing. A horizon gives the city somewhere to be: it establishes ground
// plane, scale and depth before a single building is drawn.
//
// Rendered as a big inverted sphere with a vertical gradient, unaffected by
// fog and drawn behind everything else.

import {
  BackSide,
  Color,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
} from 'three';

const VERTEX = /* glsl */ `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 bottomColor;
  uniform float horizon;
  varying vec3 vWorldPosition;

  void main() {
    float h = normalize(vWorldPosition).y;
    // Two-stop gradient: a tight, brighter band at the horizon reads as haze
    // over a distant city, which a single top-to-bottom ramp does not.
    vec3 sky = mix(horizonColor, topColor, smoothstep(0.0, horizon, h));
    vec3 ground = mix(bottomColor, horizonColor, smoothstep(-horizon, 0.0, h));
    gl_FragColor = vec4(h > 0.0 ? sky : ground, 1.0);
  }
`;

export interface SkyColors {
  readonly top: number;
  readonly horizon: number;
  readonly bottom: number;
}

export const NIGHT_SKY: SkyColors = {
  top: 0x080e1b,
  horizon: 0x1d3350,
  bottom: 0x05080f,
};

export class Sky {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(radius = 800, colors: SkyColors = NIGHT_SKY) {
    this.material = new ShaderMaterial({
      uniforms: {
        topColor: { value: new Color(colors.top) },
        horizonColor: { value: new Color(colors.horizon) },
        bottomColor: { value: new Color(colors.bottom) },
        // The ramp has to span most of the dome. Tighten it and the correct
        // night gradient stops reading as a gradient and starts reading as a
        // black slab with a hard edge across the sky.
        horizon: { value: 0.95 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: BackSide,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new Mesh(new SphereGeometry(radius, 32, 20), this.material);
    // Drawn first, so nothing has to depth-fight with it.
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  setColors(colors: SkyColors): void {
    (this.material.uniforms['topColor']?.value as Color | undefined)?.set(colors.top);
    (this.material.uniforms['horizonColor']?.value as Color | undefined)?.set(colors.horizon);
    (this.material.uniforms['bottomColor']?.value as Color | undefined)?.set(colors.bottom);
  }
}
