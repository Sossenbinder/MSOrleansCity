// Renderer, camera rig and the frame loop.
//
// The loop reports elapsed wall-clock time to its callback and does not decide
// anything about the simulation — main.ts converts wall time into simulated
// time so the speed control has exactly one owner.

import {
  ACESFilmicToneMapping,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { LAYOUT } from '../world/layout';
import { NIGHT_SKY, Sky } from './sky';

export type FrameCallback = (deltaMs: number, elapsedMs: number) => void;

export class Renderer {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;

  private readonly renderer: WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly sky = new Sky();
  /** Auto-orbit on arrival, cancelled the moment the user touches anything. */
  private introOrbit = true;
  /** THREE.Clock is deprecated; performance.now() is all this loop needs. */
  private lastFrameAt = 0;
  private frameHandle = 0;

  private flight: {
    fromPosition: Vector3;
    toPosition: Vector3;
    fromTarget: Vector3;
    toTarget: Vector3;
    elapsed: number;
    durationMs: number;
  } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;

    // Fog tuned to the horizon colour so distant geometry dissolves into the
    // sky instead of ending abruptly in mid-air.
    this.scene.fog = new Fog(NIGHT_SKY.horizon, 170, 430);
    this.scene.add(this.sky.mesh);

    this.camera = new PerspectiveCamera(46, 1, 0.5, 2600);
    this.camera.position.set(0, 104, 196);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 16, 0);
    this.controls.minDistance = 18;
    this.controls.maxDistance = 560;
    // Stop the camera dropping below the ground plane — underground views of a
    // city that has no underground yet are just confusing.
    this.controls.maxPolarAngle = Math.PI * 0.495;
    // A slow drift on arrival: a still frame looks like a screenshot, and the
    // parallax is what tells you it is three-dimensional at all.
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.32;

    // Grabbing the camera always wins over a scripted flight or the intro.
    this.controls.addEventListener('start', () => {
      this.cancelFlight();
      this.stopIntro();
    });

    // Dim ambient: at night the city should be lit by its own windows, not by
    // a floodlight. Bloom does the rest.
    this.scene.add(new HemisphereLight(0x3a5c8f, 0x05070e, 0.42));

    const sun = new DirectionalLight(0x9fc0ff, 0.55);
    sun.position.set(70, 120, -60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 400;
    const extent = LAYOUT.ringRadius * 1.6;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    this.scene.add(sun);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // The single biggest visual lever: emissive windows, registry towers and
    // vehicles bleed light, which is what makes a pile of boxes read as a lit
    // city rather than as shaded geometry.
    this.bloom = new UnrealBloomPass(
      new Vector2(window.innerWidth, window.innerHeight),
      // strength / radius / threshold. The threshold does the real work: set
      // it low and every lit surface smears, and the labels stop being
      // readable. Only lit windows, registry towers and vehicles clear it.
      0.42,
      0.45,
      0.62,
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', this.resize);
  }

  add(object: Object3D): void {
    this.scene.add(object);
  }

  /**
   * Eases the camera to a new vantage point. Used by the tour; a hard cut
   * between chapters loses the viewer's sense of where they are in the city.
   */
  flyTo(position: Vector3, target: Vector3, durationMs = 1400): void {
    this.stopIntro();
    this.flight = {
      fromPosition: this.camera.position.clone(),
      toPosition: position.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      elapsed: 0,
      durationMs,
    };
  }

  private advanceFlight(deltaMs: number): void {
    const flight = this.flight;
    if (!flight) return;

    flight.elapsed += deltaMs;
    const t = Math.min(1, flight.elapsed / flight.durationMs);
    // smoothstep, so the camera eases in and out rather than lurching
    const eased = t * t * (3 - 2 * t);

    this.camera.position.lerpVectors(flight.fromPosition, flight.toPosition, eased);
    this.controls.target.lerpVectors(flight.fromTarget, flight.toTarget, eased);

    if (t >= 1) this.flight = null;
  }

  /** Cancels any camera flight — called when the user grabs the controls. */
  cancelFlight(): void {
    this.flight = null;
  }

  /** Ends the arrival drift. Any deliberate camera move supersedes it. */
  stopIntro(): void {
    if (!this.introOrbit) return;
    this.introOrbit = false;
    this.controls.autoRotate = false;
  }

  private resize = (): void => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.composer?.setSize(width, height);
    this.bloom?.setSize(width, height);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  };

  start(onFrame: FrameCallback): void {
    let elapsed = 0;
    this.lastFrameAt = performance.now();
    const loop = (): void => {
      this.frameHandle = requestAnimationFrame(loop);
      const now = performance.now();
      // Clamped to 100ms: a backgrounded tab returns a huge delta, and
      // replaying several seconds of simulation in one tick looks like a glitch.
      const delta = Math.min(100, now - this.lastFrameAt);
      this.lastFrameAt = now;
      elapsed += delta;
      onFrame(delta, elapsed);
      this.advanceFlight(delta);
      this.controls.update();
      this.composer.render();
    };
    loop();
  }

  stop(): void {
    cancelAnimationFrame(this.frameHandle);
    window.removeEventListener('resize', this.resize);
  }
}
