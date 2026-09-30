import { nearestCell, vertexTriangles } from './sphereMesh';
import type { MeshGridMap, SphereMesh } from './types';

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

/** Latitude (radians) of row r's center in an h-row grid. */
export function gridLat(h: number, r: number): number {
  return HALF_PI - ((r + 0.5) * Math.PI) / h;
}

/** Longitude (radians) of column c's center in a w-column grid. */
export function gridLon(w: number, c: number): number {
  return -Math.PI + ((c + 0.5) * TWO_PI) / w;
}

/** Fractional row coordinate of latitude (row centers at integers). */
export function latToRow(h: number, lat: number): number {
  return ((HALF_PI - lat) / Math.PI) * h - 0.5;
}

/** Fractional column coordinate of longitude (col centers at integers), wraps into [0, w). */
export function lonToCol(w: number, lon: number): number {
  let c = ((lon + Math.PI) / TWO_PI) * w - 0.5;
  c %= w;
  if (c < 0) c += w;
  // -1e-17 + w rounds to exactly w in floating point.
  if (c >= w) c = 0;
  return c;
}

/** Precompute barycentric (Delaunay-triangle) + nearest mappings from mesh cells to a w x h grid. */
export function buildMeshGridMap(mesh: SphereMesh, w: number, h: number): MeshGridMap {
  const npx = w * h;
  const tri = new Int32Array(3 * npx);
  const bary = new Float32Array(3 * npx);
  const nearest = new Int32Array(npx);
  const { xyz, triangles, adjOffset, adj } = mesh;
  const vt = vertexTriangles(mesh);
  const cosLon = new Float64Array(w);
  const sinLon = new Float64Array(w);
  for (let c = 0; c < w; c++) {
    const lo = gridLon(w, c);
    cosLon[c] = Math.cos(lo);
    sinLon[c] = Math.sin(lo);
  }
  const wts = [0, 0, 0];

  // Barycentrics of direction d in triangle t: w_a ∝ d·(b×c), w_b ∝ d·(c×a), w_c ∝ d·(a×b).
  const triWeights = (t: number, dx: number, dy: number, dz: number): boolean => {
    const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];
    const ax = xyz[3 * a], ay = xyz[3 * a + 1], az = xyz[3 * a + 2];
    const bx = xyz[3 * b], by = xyz[3 * b + 1], bz = xyz[3 * b + 2];
    const cx = xyz[3 * c], cy = xyz[3 * c + 1], cz = xyz[3 * c + 2];
    const wa = dx * (by * cz - bz * cy) + dy * (bz * cx - bx * cz) + dz * (bx * cy - by * cx);
    const wb = dx * (cy * az - cz * ay) + dy * (cz * ax - cx * az) + dz * (cx * ay - cy * ax);
    const wc = dx * (ay * bz - az * by) + dy * (az * bx - ax * bz) + dz * (ax * by - ay * bx);
    const eps = -1e-12;
    if (wa < eps || wb < eps || wc < eps) return false;
    const s = wa + wb + wc;
    if (!(s > 0)) return false;
    wts[0] = Math.max(0, wa) / s;
    wts[1] = Math.max(0, wb) / s;
    wts[2] = Math.max(0, wc) / s;
    return true;
  };

  let rowHint = 0;
  for (let r = 0; r < h; r++) {
    const la = gridLat(h, r);
    const cl = Math.cos(la), sl = Math.sin(la);
    let hint = rowHint;
    for (let c = 0; c < w; c++) {
      const p = r * w + c;
      const dx = cl * cosLon[c], dy = cl * sinLon[c], dz = sl;
      const v = nearestCell(mesh, dx, dy, dz, hint);
      hint = v;
      if (c === 0) rowHint = v;
      nearest[p] = v;
      let found = -1;
      for (let k = vt.off[v]; k < vt.off[v + 1] && found < 0; k++) {
        if (triWeights(vt.tri[k], dx, dy, dz)) found = vt.tri[k];
      }
      if (found < 0) {
        // The containing triangle may be incident to a neighbor of the nearest vertex.
        for (let q = adjOffset[v]; q < adjOffset[v + 1] && found < 0; q++) {
          const u = adj[q];
          for (let k = vt.off[u]; k < vt.off[u + 1]; k++) {
            if (triWeights(vt.tri[k], dx, dy, dz)) {
              found = vt.tri[k];
              break;
            }
          }
        }
      }
      if (found >= 0) {
        tri[3 * p] = triangles[3 * found];
        tri[3 * p + 1] = triangles[3 * found + 1];
        tri[3 * p + 2] = triangles[3 * found + 2];
        bary[3 * p] = wts[0];
        bary[3 * p + 1] = wts[1];
        bary[3 * p + 2] = wts[2];
      } else {
        tri[3 * p] = v;
        tri[3 * p + 1] = v;
        tri[3 * p + 2] = v;
        bary[3 * p] = 1;
        bary[3 * p + 1] = 0;
        bary[3 * p + 2] = 0;
      }
    }
  }
  return { w, h, tri, bary, nearest };
}

/** Interpolate a per-cell field onto the grid (barycentric). */
export function meshToGrid(map: MeshGridMap, field: ArrayLike<number>, out?: Float32Array): Float32Array {
  const npx = map.w * map.h;
  const o = out && out.length >= npx ? out : new Float32Array(npx);
  const { tri, bary } = map;
  for (let p = 0, k = 0; p < npx; p++, k += 3) {
    o[p] = bary[k] * field[tri[k]] + bary[k + 1] * field[tri[k + 1]] + bary[k + 2] * field[tri[k + 2]];
  }
  return o;
}

/** Nearest-cell sampling for categorical per-cell fields. */
export function meshToGridNearest(map: MeshGridMap, field: ArrayLike<number>, out?: Int32Array): Int32Array {
  const npx = map.w * map.h;
  const o = out && out.length >= npx ? out : new Int32Array(npx);
  const nearest = map.nearest;
  for (let p = 0; p < npx; p++) o[p] = field[nearest[p]];
  return o;
}

/** Bilinear sample of a w x h grid field at (lat, lon): wraps in longitude, clamps in latitude. */
export function sampleGrid(field: ArrayLike<number>, w: number, h: number, lat: number, lon: number): number {
  let fr = ((HALF_PI - lat) / Math.PI) * h - 0.5;
  if (fr < 0) fr = 0;
  else if (fr > h - 1) fr = h - 1;
  let fc = ((lon + Math.PI) / TWO_PI) * w - 0.5;
  fc %= w;
  if (fc < 0) fc += w;
  if (fc >= w) fc = 0;
  const r0 = Math.floor(fr);
  const r1 = r0 + 1 < h ? r0 + 1 : h - 1;
  const tr = fr - r0;
  const c0 = Math.floor(fc) % w;
  const c1 = c0 + 1 < w ? c0 + 1 : 0;
  const tc = fc - Math.floor(fc);
  const a = field[r0 * w + c0], b = field[r0 * w + c1];
  const c = field[r1 * w + c0], d = field[r1 * w + c1];
  return (a * (1 - tc) + b * tc) * (1 - tr) + (c * (1 - tc) + d * tc) * tr;
}

/** Sample a w x h grid field at every mesh cell center (bilinear). */
export function gridToMesh(mesh: SphereMesh, field: ArrayLike<number>, w: number, h: number, out?: Float32Array): Float32Array {
  const o = out && out.length >= mesh.n ? out : new Float32Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) o[i] = sampleGrid(field, w, h, mesh.lat[i], mesh.lon[i]);
  return o;
}

/** Bilinear resample of a w x h grid to w2 x h2 (lon-wrapping). When downsampling by large factors, box-averages. */
export function resampleGrid(field: ArrayLike<number>, w: number, h: number, w2: number, h2: number, out?: Float32Array): Float32Array {
  const o = out && out.length >= w2 * h2 ? out : new Float32Array(w2 * h2);
  if (w2 * 2 <= w && h2 * 2 <= h) {
    // Box average over the source pixels covered by each destination pixel.
    for (let r = 0; r < h2; r++) {
      const r0 = Math.floor((r * h) / h2);
      const r1 = Math.max(r0 + 1, Math.floor(((r + 1) * h) / h2));
      for (let c = 0; c < w2; c++) {
        const c0 = Math.floor((c * w) / w2);
        const c1 = Math.max(c0 + 1, Math.floor(((c + 1) * w) / w2));
        let s = 0;
        let k = 0;
        for (let rr = r0; rr < r1; rr++) {
          const row = rr * w;
          for (let cc = c0; cc < c1; cc++) {
            const v = field[row + (cc % w)];
            if (v === v) {
              s += v;
              k++;
            }
          }
        }
        o[r * w2 + c] = k > 0 ? s / k : NaN;
      }
    }
    return o;
  }
  for (let r = 0; r < h2; r++) {
    let fr = ((r + 0.5) * h) / h2 - 0.5;
    if (fr < 0) fr = 0;
    else if (fr > h - 1) fr = h - 1;
    const r0 = Math.floor(fr);
    const r1 = r0 + 1 < h ? r0 + 1 : h - 1;
    const tr = fr - r0;
    for (let c = 0; c < w2; c++) {
      let fc = ((c + 0.5) * w) / w2 - 0.5;
      if (fc < 0) fc += w;
      const c0 = Math.floor(fc) % w;
      const c1 = c0 + 1 < w ? c0 + 1 : 0;
      const tc = fc - Math.floor(fc);
      const a = field[r0 * w + c0], b = field[r0 * w + c1];
      const cc = field[r1 * w + c0], d = field[r1 * w + c1];
      o[r * w2 + c] = (a * (1 - tc) + b * tc) * (1 - tr) + (cc * (1 - tc) + d * tc) * tr;
    }
  }
  return o;
}
