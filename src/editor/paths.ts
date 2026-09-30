import { DEG } from '../core/constants';
import { angleBetween, tangentBasis } from '../core/math3';
import { cellsWithinRadius, nearestCell } from '../core/sphereMesh';
import type { SphereMesh, Vec3 } from '../core/types';
import { slerp } from './stroke';

function adjacent(mesh: SphereMesh, a: number, b: number): boolean {
  for (let e = mesh.adjOffset[a]; e < mesh.adjOffset[a + 1]; e++) if (mesh.adj[e] === b) return true;
  return false;
}

/**
 * Append a chain of mesh-adjacent cells leading from `from` to `to` (excluding `from`, including
 * `to`), by greedy routing on the Delaunay graph (each hop moves to the neighbour closest to the
 * target, which always makes progress on a Delaunay triangulation).
 */
function bridge(mesh: SphereMesh, from: number, to: number, out: number[]): void {
  const { xyz, adjOffset, adj } = mesh;
  const tx = xyz[3 * to], ty = xyz[3 * to + 1], tz = xyz[3 * to + 2];
  let cur = from;
  for (let guard = 0; guard < 10_000 && cur !== to; guard++) {
    let best = -1, bestDot = -Infinity;
    for (let e = adjOffset[cur]; e < adjOffset[cur + 1]; e++) {
      const j = adj[e];
      const d = xyz[3 * j] * tx + xyz[3 * j + 1] * ty + xyz[3 * j + 2] * tz;
      if (d > bestDot) {
        bestDot = d;
        best = j;
      }
    }
    if (best < 0) break;
    cur = best;
    out.push(cur);
  }
}

/**
 * Cells along a polyline of great-circle segments, as chains of mesh-adjacent cells (a
 * watertight cut on the mesh graph: cells on either side cannot be neighbours across it). Null
 * entries break the polyline. `closed` adds the segment from the last point back to the first.
 * Returns unique cells in path order.
 */
export function pathCells(mesh: SphereMesh, points: ReadonlyArray<Vec3 | null>, closed = false): number[] {
  const step = mesh.spacing / 3;
  const chain: number[] = [];
  let prevCell = -1;
  const visit = (p: Vec3) => {
    const c = nearestCell(mesh, p[0], p[1], p[2], prevCell >= 0 ? prevCell : undefined);
    if (c === prevCell) return;
    if (prevCell >= 0 && !adjacent(mesh, prevCell, c)) bridge(mesh, prevCell, c, chain);
    else chain.push(c);
    prevCell = c;
  };
  const segment = (a: Vec3, b: Vec3) => {
    const theta = angleBetween(a, b);
    const k = Math.max(1, Math.ceil(theta / step));
    for (let s = 1; s <= k; s++) visit(slerp(a, b, s / k, theta));
  };
  let last: Vec3 | null = null;
  let first: Vec3 | null = null;
  for (const p of points) {
    if (!p) {
      last = null;
      prevCell = -1;
      continue;
    }
    if (!first) first = p;
    if (last) segment(last, p);
    else visit(p);
    last = p;
  }
  if (closed && last && first && last !== first) segment(last, first);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const c of chain) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/**
 * Cells whose centres lie inside a closed spherical polygon (vertices in order; the closing edge
 * is implied). Edges are densified to ≤ 1° and the test runs in a stereographic projection centred
 * on the polygon (great-circle edges are nearly straight there at that density), with an even-odd
 * crossing rule accelerated by horizontal edge bands. Polygons are assumed to be smaller than a
 * hemisphere (the region on the side of the vertex mean).
 */
export function cellsInsidePolygon(mesh: SphereMesh, poly: ReadonlyArray<Vec3>): number[] {
  if (poly.length < 3) return [];
  // Densify.
  const pts: Vec3[] = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const theta = angleBetween(a, b);
    const m = Math.max(1, Math.ceil(theta / DEG));
    for (let s = 0; s < m; s++) pts.push(s === 0 ? a : slerp(a, b, s / m, theta));
  }
  let sx = 0, sy = 0, sz = 0;
  for (const p of pts) {
    sx += p[0];
    sy += p[1];
    sz += p[2];
  }
  const sl = Math.hypot(sx, sy, sz);
  if (!(sl > 1e-9)) return [];
  const c: Vec3 = [sx / sl, sy / sl, sz / sl];
  let maxAng = 0;
  for (const p of pts) maxAng = Math.max(maxAng, angleBetween(c, p));
  if (maxAng >= Math.PI - 1e-3) return [];
  const { east: e1, north: e2 } = tangentBasis(c);
  const m = pts.length;
  const px = new Float64Array(m), py = new Float64Array(m);
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (let k = 0; k < m; k++) {
    const p = pts[k];
    const den = 1 + p[0] * c[0] + p[1] * c[1] + p[2] * c[2];
    px[k] = (p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2]) / den;
    py[k] = (p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2]) / den;
    minX = Math.min(minX, px[k]);
    maxX = Math.max(maxX, px[k]);
    minY = Math.min(minY, py[k]);
    maxY = Math.max(maxY, py[k]);
  }
  // Edge bands.
  const nb = Math.max(1, Math.min(256, m >> 2));
  const bandH = (maxY - minY) / nb || 1;
  const bands: number[][] = Array.from({ length: nb }, () => []);
  for (let k = 0; k < m; k++) {
    const k2 = (k + 1) % m;
    const y0 = Math.min(py[k], py[k2]), y1 = Math.max(py[k], py[k2]);
    const b0 = Math.max(0, Math.floor((y0 - minY) / bandH));
    const b1 = Math.min(nb - 1, Math.floor((y1 - minY) / bandH));
    for (let b = b0; b <= b1; b++) bands[b].push(k);
  }
  const cand = cellsWithinRadius(mesh, c, maxAng + mesh.spacing);
  const out: number[] = [];
  const { xyz } = mesh;
  for (const i of cand) {
    const qx0 = xyz[3 * i], qy0 = xyz[3 * i + 1], qz0 = xyz[3 * i + 2];
    const den = 1 + qx0 * c[0] + qy0 * c[1] + qz0 * c[2];
    if (den < 1e-6) continue;
    const x = (qx0 * e1[0] + qy0 * e1[1] + qz0 * e1[2]) / den;
    const y = (qx0 * e2[0] + qy0 * e2[1] + qz0 * e2[2]) / den;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    const b = Math.min(nb - 1, Math.max(0, Math.floor((y - minY) / bandH)));
    let inside = false;
    for (const k of bands[b]) {
      const k2 = (k + 1) % m;
      const ya = py[k], yb = py[k2];
      if (ya > y !== yb > y) {
        const xc = px[k] + ((y - ya) / (yb - ya)) * (px[k2] - px[k]);
        if (xc > x) inside = !inside;
      }
    }
    if (inside) out.push(i);
  }
  return out;
}

/**
 * Straight-line continuation of a split cut: each end of the drawn polyline that lies inside the
 * plate being cut (the plate most of the cut's cells belong to) is extended along its great circle
 * until it leaves that plate or runs into the cut itself. So a short line in the middle of a plate
 * still splits it edge to edge, and a line on a plate that covers the whole sphere closes into a
 * loop and cuts it in two. Returns the extended polyline (the input when nothing extends).
 */
export function extendCut(mesh: SphereMesh, plate: Int16Array, points: ReadonlyArray<Vec3 | null>): Array<Vec3 | null> {
  const pts = points.filter((p): p is Vec3 => p !== null);
  if (pts.length < 2) return [...points];
  const cells = pathCells(mesh, points, false);
  if (cells.length < 2) return [...points];
  // Target plate: the one the cut runs through the most.
  const tally = new Map<number, number>();
  for (const c of cells) tally.set(plate[c], (tally.get(plate[c]) ?? 0) + 1);
  let target = -1, best = 0;
  for (const [k, v] of tally) {
    if (v > best) {
      best = v;
      target = k;
    }
  }
  const onCut = new Set(cells);
  const step = 0.5 * mesh.spacing;
  const minTravel = 3 * mesh.spacing;
  /** Point `back` radians before `end` along the drawn path (for a stable end direction). */
  const directionFrom = (seq: Vec3[]): Vec3 | null => {
    const end = seq[seq.length - 1];
    for (let k = seq.length - 2; k >= 0; k--) if (angleBetween(seq[k], end) >= 0.75 * mesh.spacing) return seq[k];
    return seq.length >= 2 && angleBetween(seq[0], end) > 1e-6 ? seq[0] : null;
  };
  const touchesCut = (c: number): boolean => {
    if (onCut.has(c)) return true;
    for (let e = mesh.adjOffset[c]; e < mesh.adjOffset[c + 1]; e++) if (onCut.has(mesh.adj[e])) return true;
    return false;
  };
  let closed = false;
  const extend = (seq: Vec3[]): Vec3[] => {
    const end = seq[seq.length - 1];
    const endCell = nearestCell(mesh, end[0], end[1], end[2]);
    if (plate[endCell] !== target) return [];
    const prev = directionFrom(seq);
    if (!prev) return [];
    // Forward tangent at `end` of the great circle prev → end.
    const ax = [prev[1] * end[2] - prev[2] * end[1], prev[2] * end[0] - prev[0] * end[2], prev[0] * end[1] - prev[1] * end[0]];
    const al = Math.hypot(ax[0], ax[1], ax[2]);
    if (al < 1e-12) return [];
    const k = [ax[0] / al, ax[1] / al, ax[2] / al];
    const t: Vec3 = [k[1] * end[2] - k[2] * end[1], k[2] * end[0] - k[0] * end[2], k[0] * end[1] - k[1] * end[0]];
    const out: Vec3[] = [];
    let hint = endCell;
    for (let s = step; s < 2 * Math.PI; s += step) {
      const c = Math.cos(s), sn = Math.sin(s);
      const q: Vec3 = [end[0] * c + t[0] * sn, end[1] * c + t[1] * sn, end[2] * c + t[2] * sn];
      hint = nearestCell(mesh, q[0], q[1], q[2], hint);
      out.push(q);
      if (plate[hint] !== target) break; // reached the plate's edge (one cell beyond it)
      if (s > minTravel && touchesCut(hint)) {
        closed = true; // ran into the cut: the loop is closed
        break;
      }
    }
    for (const q of out) onCut.add(nearestCell(mesh, q[0], q[1], q[2]));
    return out;
  };
  const tail = extend(pts);
  // A tail that closed a loop already separates the plate: extending the other end too would only
  // cut the loop's inside once more.
  const head = closed ? [] : extend([...pts].reverse());
  if (!tail.length && !head.length) return [...points];
  return [...head.reverse(), ...points, ...tail];
}
