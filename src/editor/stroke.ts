import { angleBetween } from '../core/math3';
import type { Noise3 } from '../core/noise';
import { fbm3 } from '../core/noise';
import { cellsWithinRadius, nearestCell } from '../core/sphereMesh';
import type { SphereMesh, Vec3 } from '../core/types';
import { MAX_STROKE_JUMP } from './editorConstants';

/** Spherical linear interpolation between unit vectors a and b (angle theta between them). */
export function slerp(a: Vec3, b: Vec3, t: number, theta = angleBetween(a, b)): Vec3 {
  let wa: number, wb: number;
  if (theta < 1e-6) {
    wa = 1 - t;
    wb = t;
  } else {
    const s = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / s;
    wb = Math.sin(t * theta) / s;
  }
  const x = wa * a[0] + wb * b[0], y = wa * a[1] + wb * b[1], z = wa * a[2] + wb * b[2];
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/**
 * Turns pointer samples into brush dab centres along great circles (the short way, so strokes
 * cross the antimeridian and the poles naturally). Dabs are spaced exactly `step` radians apart
 * along the path, carrying the remainder across samples; a null sample breaks the stroke (pointer
 * left the planet). In 'cover' mode a dab is also placed at every sample so idempotent brushes
 * always reach the cursor; 'uniform' mode (additive brushes) keeps strictly even spacing.
 */
export class StrokeInterpolator {
  private last: Vec3 | null = null;
  private since = 0;

  constructor(
    private readonly step: number,
    private readonly mode: 'cover' | 'uniform' = 'cover',
  ) {
    if (!(step > 0)) throw new Error(`StrokeInterpolator: step must be > 0 (got ${step})`);
  }

  /** Dab centres produced by moving the pointer to p (appended to out). */
  moveTo(p: Vec3 | null, out: Vec3[] = []): Vec3[] {
    if (!p) {
      this.last = null;
      return out;
    }
    const last = this.last;
    if (!last) {
      this.last = p;
      this.since = 0;
      out.push(p);
      return out;
    }
    const theta = angleBetween(last, p);
    if (theta < 1e-9) return out;
    if (theta > MAX_STROKE_JUMP) {
      // Near-antipodal jump: the great circle is undefined, restart the stroke here.
      this.last = p;
      this.since = 0;
      out.push(p);
      return out;
    }
    let t = this.step - this.since;
    while (t <= theta) {
      out.push(slerp(last, p, t / theta, theta));
      t += this.step;
    }
    this.since = theta - (t - this.step);
    this.last = p;
    if (this.mode === 'cover' && this.since > 1e-9) out.push(p);
    return out;
  }

  /** True while a stroke segment is in progress (a previous sample exists). */
  get drawing(): boolean {
    return this.last !== null;
  }

  reset(): void {
    this.last = null;
    this.since = 0;
  }
}

/** Optional noisy footprint: the dab reaches radius·(1 + amp·fbm(p)) (organic continent edges). */
export interface DabRoughness {
  noise: Noise3;
  amp: number;
  /** Noise frequency on the unit sphere. */
  freq: number;
}

/**
 * Cells covered by a dab of `radius` radians at `center`, appended to `out` (cleared first).
 * The radius is at least one mesh spacing and the cell nearest to the centre is always included,
 * so even the smallest brush paints something.
 */
export function dabCells(mesh: SphereMesh, center: Vec3, radius: number, out: number[], rough?: DabRoughness): number[] {
  const r = Math.max(radius, mesh.spacing);
  const reach = rough ? r * (1 + rough.amp) : r;
  cellsWithinRadius(mesh, center, reach, out);
  if (rough) {
    const { xyz } = mesh;
    let w = 0;
    for (let k = 0; k < out.length; k++) {
      const i = out[k];
      const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
      const d = Math.acos(Math.max(-1, Math.min(1, px * center[0] + py * center[1] + pz * center[2])));
      const f = rough.freq;
      const lim = r * (1 + rough.amp * fbm3(rough.noise, px * f, py * f, pz * f, 3));
      if (d <= lim) out[w++] = i;
    }
    out.length = w;
  }
  const c = nearestCell(mesh, center[0], center[1], center[2]);
  if (out.indexOf(c) < 0) out.push(c);
  return out;
}
