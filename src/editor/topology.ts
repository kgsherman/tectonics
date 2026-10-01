import type { SphereMesh, Vec3 } from '../core/types';

/** Connected components of equal plate label over the mesh graph. */
export interface Components {
  /** Component id per cell. */
  comp: Int32Array;
  /** Cell count per component. */
  size: number[];
  /** Plate label per component. */
  label: number[];
}

export function labelComponents(mesh: SphereMesh, plate: Int16Array): Components {
  const { n, adjOffset, adj } = mesh;
  const comp = new Int32Array(n).fill(-1);
  const size: number[] = [];
  const label: number[] = [];
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const c = size.length;
    const lab = plate[s];
    let head = 0, tail = 0;
    queue[tail++] = s;
    comp[s] = c;
    while (head < tail) {
      const i = queue[head++];
      for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
        const j = adj[e];
        if (comp[j] < 0 && plate[j] === lab) {
          comp[j] = c;
          queue[tail++] = j;
        }
      }
    }
    size.push(tail);
    label.push(lab);
  }
  return { comp, size, label };
}

/**
 * Cells of one plate reachable from `start` without crossing another plate (flood fill region).
 * `blocked` cells (optional) are treated as walls.
 */
export function floodRegion(mesh: SphereMesh, plate: Int16Array, start: number, blocked?: Uint8Array): number[] {
  const { adjOffset, adj } = mesh;
  const lab = plate[start];
  const seen = new Uint8Array(mesh.n);
  const out = [start];
  seen[start] = 1;
  for (let h = 0; h < out.length; h++) {
    const i = out[h];
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      const j = adj[e];
      if (seen[j] || plate[j] !== lab || (blocked && blocked[j])) continue;
      seen[j] = 1;
      out.push(j);
    }
  }
  return out;
}

/**
 * The plate sharing the most mesh edges with `cells` (all of which must currently belong to one
 * region), excluding `exclude`. Ties go to the lower plate index. -1 if the region touches no other plate.
 */
export function longestBorderNeighbor(mesh: SphereMesh, plate: Int16Array, cells: ArrayLike<number>, exclude: number, numPlates: number): number {
  const { adjOffset, adj } = mesh;
  const count = new Int32Array(numPlates);
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      const p = plate[adj[e]];
      if (p !== exclude && p >= 0 && p < numPlates) count[p]++;
    }
  }
  let best = -1, bestCount = 0;
  for (let p = 0; p < numPlates; p++) {
    if (count[p] > bestCount) {
      bestCount = count[p];
      best = p;
    }
  }
  return best;
}

/** Cell counts per plate index (length numPlates). */
export function plateCounts(plate: Int16Array, numPlates: number, out?: Int32Array): Int32Array {
  const c = out && out.length >= numPlates ? out : new Int32Array(numPlates);
  c.fill(0);
  for (let i = 0; i < plate.length; i++) {
    const k = plate[i];
    if (k >= 0 && k < numPlates) c[k]++;
  }
  return c;
}

/**
 * Each plate's "interior point" for motion handles: the cell farthest (in graph hops) from any
 * plate boundary — a discrete pole of inaccessibility, always inside the plate even for ring- or
 * crescent-shaped plates whose centroid lies outside. Ties go to the cell closest to the plate's
 * centroid (when the centroid is well defined, |mean| ≥ eps). A plate with no boundary (it covers
 * the sphere) uses its centroid, or the cell nearest lat 0 / lon 0 when the centroid vanishes.
 * Plates with no cells get null.
 */
export function plateAnchors(mesh: SphereMesh, plate: Int16Array, numPlates: number, eps = 1e-3): Array<Vec3 | null> {
  const { n, xyz, adjOffset, adj } = mesh;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const a = plate[i];
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      if (plate[adj[e]] !== a) {
        dist[i] = 0;
        queue[tail++] = i;
        break;
      }
    }
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      const j = adj[e];
      if (dist[j] < 0) {
        dist[j] = dist[i] + 1;
        queue[tail++] = j;
      }
    }
  }
  // Centroids (sum of unit vectors) and counts.
  const sum = new Float64Array(3 * numPlates);
  const count = new Int32Array(numPlates);
  for (let i = 0; i < n; i++) {
    const k = plate[i];
    if (k < 0 || k >= numPlates) continue;
    sum[3 * k] += xyz[3 * i];
    sum[3 * k + 1] += xyz[3 * i + 1];
    sum[3 * k + 2] += xyz[3 * i + 2];
    count[k]++;
  }
  const cen: Array<Vec3 | null> = [];
  for (let k = 0; k < numPlates; k++) {
    const l = Math.hypot(sum[3 * k], sum[3 * k + 1], sum[3 * k + 2]);
    cen.push(count[k] > 0 && l >= eps * count[k] ? [sum[3 * k] / l, sum[3 * k + 1] / l, sum[3 * k + 2] / l] : null);
  }
  const best = new Int32Array(numPlates).fill(-1);
  const bestD = new Int32Array(numPlates).fill(-1);
  const bestDot = new Float64Array(numPlates).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const k = plate[i];
    if (k < 0 || k >= numPlates) continue;
    const d = dist[i]; // -1 if the plate has no boundary anywhere
    const c = cen[k];
    const dot = c ? xyz[3 * i] * c[0] + xyz[3 * i + 1] * c[1] + xyz[3 * i + 2] * c[2] : -i;
    if (d > bestD[k] || (d === bestD[k] && dot > bestDot[k])) {
      bestD[k] = d;
      bestDot[k] = dot;
      best[k] = i;
    }
  }
  const out: Array<Vec3 | null> = [];
  for (let k = 0; k < numPlates; k++) {
    if (count[k] === 0) {
      out.push(null);
      continue;
    }
    if (bestD[k] < 0) {
      // Plate without boundary: it is the whole sphere.
      if (cen[k]) out.push(cen[k]);
      else out.push([1, 0, 0]);
      continue;
    }
    const i = best[k];
    out.push([xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]);
  }
  return out;
}

/** Hops from every cell to the nearest plate boundary (0 on boundary cells; -1 everywhere if no boundary exists). */
export function boundaryDistance(mesh: SphereMesh, plate: Int16Array): Int32Array {
  const { n, adjOffset, adj } = mesh;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const a = plate[i];
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      if (plate[adj[e]] !== a) {
        dist[i] = 0;
        queue[tail++] = i;
        break;
      }
    }
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      const j = adj[e];
      if (dist[j] < 0) {
        dist[j] = dist[i] + 1;
        queue[tail++] = j;
      }
    }
  }
  return dist;
}

/** Lat/lon buckets for spreading interior points over a plate (≈15° × 15°). */
const BUCKET_DEG = 15;
const BUCKET_ROWS = Math.ceil(180 / BUCKET_DEG);
const BUCKET_COLS = Math.ceil(360 / BUCKET_DEG);

/**
 * Alternative motion-arrow positions per plate: well-interior cells (boundary distance ≥ `minShare`
 * of the plate's deepest cell, at least 1 hop) spread over the plate — the deepest cell of each
 * ~15° lat/lon bucket the plate covers. When a plate's anchor is on the hidden side of the globe its
 * arrow can be drawn at the visible one of these nearest the view centre. Plates without cells get
 * an empty list; a plate covering the whole sphere gets one point per bucket.
 */
export function plateInteriorPoints(mesh: SphereMesh, plate: Int16Array, numPlates: number, minShare = 0.4): Vec3[][] {
  const { n, xyz, lat, lon } = mesh;
  const dist = boundaryDistance(mesh, plate);
  const maxD = new Int32Array(numPlates).fill(-1);
  for (let i = 0; i < n; i++) {
    const k = plate[i];
    if (k >= 0 && k < numPlates && dist[i] > maxD[k]) maxD[k] = dist[i];
  }
  const nb = BUCKET_ROWS * BUCKET_COLS;
  const best = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const k = plate[i];
    if (!(k >= 0 && k < numPlates)) continue;
    const d = dist[i];
    // Plates without a boundary (dist -1 everywhere) accept every cell.
    if (maxD[k] >= 0 && d < Math.max(1, Math.round(minShare * maxD[k]))) continue;
    const r = Math.min(BUCKET_ROWS - 1, Math.max(0, Math.floor(((lat[i] * 180) / Math.PI + 90) / BUCKET_DEG)));
    const c = Math.min(BUCKET_COLS - 1, Math.max(0, Math.floor(((lon[i] * 180) / Math.PI + 180) / BUCKET_DEG)));
    const key = k * nb + r * BUCKET_COLS + c;
    const cur = best.get(key);
    if (cur === undefined || dist[cur] < d) best.set(key, i);
  }
  const out: Vec3[][] = Array.from({ length: numPlates }, () => []);
  for (const [key, i] of best) out[Math.floor(key / nb)].push([xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]);
  return out;
}
