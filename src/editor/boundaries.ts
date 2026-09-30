import { EARTH_RADIUS_KM } from '../core/constants';
import type { PlateSpec, SphereMesh } from '../core/types';
import { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_NONE, BOUNDARY_TRANSFORM } from '../core/types';

/** ~2 km/Myr on the unit sphere: slower relative motion counts as transform. */
const TINY = 2 / EARTH_RADIUS_KM;

/**
 * Boundary class of one cell — the same rule as draft.ts classifyBoundaries (mean normal and
 * tangential relative velocity over neighbours on other plates), evaluated locally so the editor
 * can reclassify only the cells around an edit.
 */
export function classifyCell(mesh: SphereMesh, plate: Int16Array, plates: PlateSpec[], i: number): number {
  const { xyz, adjOffset, adj } = mesh;
  const np = plates.length;
  const a = plate[i];
  if (a < 0 || a >= np) return BOUNDARY_NONE;
  const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
  const wa = plates[a].omega;
  let normalSum = 0, tangSum = 0, cnt = 0;
  for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
    const j = adj[e];
    const b = plate[j];
    if (b === a || b < 0 || b >= np) continue;
    // Boundary normal from i toward j in the tangent plane at i.
    let nx = xyz[3 * j] - px, ny = xyz[3 * j + 1] - py, nz = xyz[3 * j + 2] - pz;
    const d = nx * px + ny * py + nz * pz;
    nx -= d * px; ny -= d * py; nz -= d * pz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // Velocity of the other plate relative to this one: (w_b − w_a) × p.
    const wb = plates[b].omega;
    const wx = wb[0] - wa[0], wy = wb[1] - wa[1], wz = wb[2] - wa[2];
    const vx = wy * pz - wz * py, vy = wz * px - wx * pz, vz = wx * py - wy * px;
    const vn = vx * nx + vy * ny + vz * nz;
    const tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
    normalSum += vn;
    tangSum += Math.hypot(tx, ty, tz);
    cnt++;
  }
  if (cnt === 0) return BOUNDARY_NONE;
  const vn = normalSum / cnt;
  const vt = tangSum / cnt;
  if (Math.abs(vn) < TINY && vt < TINY) return BOUNDARY_TRANSFORM;
  if (Math.abs(vn) < 0.5 * vt) return BOUNDARY_TRANSFORM;
  return vn < 0 ? BOUNDARY_CONVERGENT : BOUNDARY_DIVERGENT;
}

/**
 * Incrementally maintained boundary classes. Callers report which cells changed plate (their
 * 1-ring is reclassified) or whose plate changed motion.
 */
export class BoundaryField {
  readonly cls: Uint8Array;
  private readonly stamp: Int32Array;
  private gen = 0;

  constructor(private readonly mesh: SphereMesh) {
    this.cls = new Uint8Array(mesh.n);
    this.stamp = new Int32Array(mesh.n);
  }

  reclassifyAll(plate: Int16Array, plates: PlateSpec[]): void {
    for (let i = 0; i < this.mesh.n; i++) this.cls[i] = classifyCell(this.mesh, plate, plates, i);
  }

  /**
   * Reclassify `cells[0..count)` and their neighbours (plate membership changed there). Every
   * reclassified cell is appended to `touched` (deduplicated), if given.
   */
  reclassifyAround(plate: Int16Array, plates: PlateSpec[], cells: ArrayLike<number>, count: number, touched?: number[]): void {
    const { adjOffset, adj } = this.mesh;
    this.nextGen();
    const g = this.gen;
    for (let k = 0; k < count; k++) {
      const i = cells[k];
      if (this.stamp[i] !== g) {
        this.stamp[i] = g;
        this.cls[i] = classifyCell(this.mesh, plate, plates, i);
        touched?.push(i);
      }
      for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
        const j = adj[e];
        if (this.stamp[j] === g) continue;
        this.stamp[j] = g;
        this.cls[j] = classifyCell(this.mesh, plate, plates, j);
        touched?.push(j);
      }
    }
  }

  /** Reclassify every boundary cell on or next to plate k (its motion changed). Changed cells go to `changed`. */
  reclassifyPlate(plate: Int16Array, plates: PlateSpec[], k: number, changed?: number[]): void {
    const { n, adjOffset, adj } = this.mesh;
    for (let i = 0; i < n; i++) {
      if (this.cls[i] === BOUNDARY_NONE) continue;
      let involved = plate[i] === k;
      if (!involved) {
        for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
          if (plate[adj[e]] === k) {
            involved = true;
            break;
          }
        }
      }
      if (!involved) continue;
      const c = classifyCell(this.mesh, plate, plates, i);
      if (c !== this.cls[i]) {
        this.cls[i] = c;
        changed?.push(i);
      }
    }
  }

  private nextGen(): void {
    this.gen++;
    if (this.gen >= 0x7fffffff) {
      this.stamp.fill(0);
      this.gen = 1;
    }
  }
}
