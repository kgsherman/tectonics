/**
 * OrbitControls configured for a planet: damping, zoom limits, no pan, LEFT and RIGHT rotate, rotate
 * speed proportional to altitude (the surface under the cursor roughly follows the drag), and the
 * paint-mode switch that frees plain left-drags for the app.
 */
import { MOUSE, TOUCH } from 'three';
import type { PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** Default camera distance (planet radii): the globe fills ~80% of the view height at fov 35°. */
export const DEFAULT_DISTANCE = 4.0;
const MAX_DISTANCE = 9;

export class GlobeControls {
  readonly orbit: OrbitControls;
  private mode: 'navigate' | 'paint' = 'navigate';

  constructor(private readonly camera: PerspectiveCamera, canvas: HTMLCanvasElement) {
    const o = new OrbitControls(camera, canvas);
    o.enableDamping = true;
    o.dampingFactor = 0.09;
    o.enablePan = false;
    o.zoomSpeed = 0.9;
    o.minDistance = 1.15;
    o.maxDistance = MAX_DISTANCE;
    o.minPolarAngle = 0.001;
    o.maxPolarAngle = Math.PI - 0.001;
    o.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    o.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE };
    o.target.set(0, 0, 0);
    this.orbit = o;
  }

  setMode(mode: 'navigate' | 'paint'): void {
    this.mode = mode;
    this.orbit.mouseButtons.LEFT = mode === 'navigate' ? MOUSE.ROTATE : null;
    this.orbit.touches.ONE = mode === 'navigate' ? TOUCH.ROTATE : null;
  }

  /** Called (capture phase, before OrbitControls sees the event) for each press in paint mode. */
  preparePress(navigates: boolean): void {
    if (this.mode === 'paint') this.orbit.mouseButtons.LEFT = navigates ? MOUSE.ROTATE : null;
  }

  /** Keeps the camera outside the displaced relief. */
  setMinAltitude(maxDisplacement: number): void {
    this.orbit.minDistance = 1.15 + maxDisplacement;
  }

  get distance(): number {
    return this.camera.position.length();
  }

  /**
   * Advances damping; returns true if the camera moved. Rotation angle per pixel matches the
   * surface's angular size near the view center: 2π·rotateSpeed/height = 2(d−1)tan(fov/2)/height.
   */
  update(dt: number): boolean {
    const d = this.distance;
    const tanHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    this.orbit.rotateSpeed = Math.max(0.02, ((d - 1) * tanHalf) / Math.PI) * 1.15;
    return this.orbit.update(dt);
  }

  dispose(): void {
    this.orbit.dispose();
  }
}
