/**
 * CPU copy of the display height map (m, row 0 = north) for picking against relief, placing
 * particles/markers/arrows above the displaced surface and masking land for ocean-current particles.
 */
import { sampleGrid } from '../core/grid';
import { copyIfChanged } from './viewBuffers';
import { reliefDisplacement } from './viewUtil';

export class HeightField {
  w = 0;
  h = 0;
  data: Float32Array | null = null;
  /** Highest elevation in the map (m); −Infinity when empty. */
  maxElev = -Infinity;

  /** Copies the map; returns false when it is identical to the current one (same size and values). */
  set(height: Float32Array, w: number, h: number): boolean {
    if (!(w > 0 && h > 0) || height.length < w * h) throw new Error(`HeightField: expected ${w}x${h} floats, got ${height.length}`);
    const sameSize = this.data !== null && this.w === w && this.h === h;
    if (!this.data || this.data.length !== w * h) this.data = new Float32Array(w * h);
    const changed = copyIfChanged(height, this.data, w * h) || !sameSize;
    this.w = w;
    this.h = h;
    if (!changed) return false;
    let mx = -Infinity;
    const d = this.data;
    for (let i = 0; i < d.length; i++) if (d[i] > mx) mx = d[i];
    this.maxElev = mx;
    return true;
  }

  clear(): void {
    this.data = null;
    this.w = this.h = 0;
    this.maxElev = -Infinity;
  }

  get present(): boolean {
    return this.data !== null;
  }

  /** Bilinear elevation at lat/lon (radians); NaN when no map is set. */
  at(lat: number, lon: number): number {
    return this.data ? sampleGrid(this.data, this.w, this.h, lat, lon) : NaN;
  }

  /** Elevation at a geo unit vector (z = north). */
  atVec(x: number, y: number, z: number): number {
    if (!this.data) return NaN;
    return sampleGrid(this.data, this.w, this.h, Math.asin(z > 1 ? 1 : z < -1 ? -1 : z), Math.atan2(y, x));
  }

  /** Unit-sphere displacement at a geo unit vector (0 without a map). */
  displacementAt(x: number, y: number, z: number, seaLevel: number, exaggeration: number): number {
    if (!this.data || exaggeration <= 0) return 0;
    return reliefDisplacement(this.atVec(x, y, z), seaLevel, exaggeration);
  }

  /** Largest displacement anywhere (upper bound for picking and camera limits). */
  maxDisplacement(seaLevel: number, exaggeration: number): number {
    return this.data ? reliefDisplacement(this.maxElev, seaLevel, exaggeration) : 0;
  }
}
