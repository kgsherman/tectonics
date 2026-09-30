import Delaunator from 'delaunator';
import type { SphereMesh, Vec3 } from './types';

/**
 * Build the spherical Fibonacci lattice with n points, its spherical Delaunay triangulation
 * (triangles + CSR adjacency) and the nearest-cell lookup table. Deterministic for a given n.
 */
export function createSphereMesh(n: number): SphereMesh {
  if (!Number.isInteger(n) || n < 32) throw new Error(`createSphereMesh: n must be an integer >= 32 (got ${n})`);
  const xyz = new Float64Array(3 * n);
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);
  const ga = (Math.sqrt(5) - 1) / 2; // Φ - 1
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * i + 1) / n;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const f = (i * ga) % 1;
    const phi = 2 * Math.PI * f;
    const x = r * Math.cos(phi);
    const y = r * Math.sin(phi);
    xyz[3 * i] = x;
    xyz[3 * i + 1] = y;
    xyz[3 * i + 2] = z;
    lat[i] = Math.asin(z);
    let lo = Math.atan2(y, x);
    if (lo <= -Math.PI) lo += 2 * Math.PI;
    lon[i] = lo;
  }

  const triangles = sphericalDelaunay(xyz, n);
  const { adjOffset, adj } = buildAdjacency(triangles, n, xyz);

  // Mean neighbor spacing.
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const ax = xyz[3 * i], ay = xyz[3 * i + 1], az = xyz[3 * i + 2];
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      const j = adj[k];
      if (j <= i) continue;
      const d = ax * xyz[3 * j] + ay * xyz[3 * j + 1] + az * xyz[3 * j + 2];
      sum += Math.acos(Math.min(1, Math.max(-1, d)));
      cnt++;
    }
  }
  const spacing = cnt > 0 ? sum / cnt : Math.sqrt((4 * Math.PI) / n);

  const lutH = Math.max(16, 2 * Math.ceil(Math.sqrt(n / 2)));
  const lutW = 2 * lutH;
  const mesh: SphereMesh = {
    n,
    xyz,
    lat,
    lon,
    adjOffset,
    adj,
    triangles,
    spacing,
    cellArea: (4 * Math.PI) / n,
    lutW,
    lutH,
    lut: new Int32Array(lutW * lutH),
  };
  buildLut(mesh);
  return mesh;
}

function sphericalDelaunay(xyz: Float64Array, n: number): Int32Array {
  // Rotate so that point 0 sits exactly at the north pole, then stereographically project the
  // remaining points from that pole. The planar Delaunay triangulation of the projected points
  // equals the spherical Delaunay triangulation minus the fan around point 0, which we close by
  // connecting every convex-hull edge to point 0.
  const px = xyz[0], py = xyz[1], pz = xyz[2];
  // Rotation R taking p0 to z_hat: axis = p0 x z_hat, angle = acos(p0 . z_hat).
  let ax = py, ay = -px; // p0 x (0,0,1) = (py, -px, 0)
  const al = Math.hypot(ax, ay);
  const ang = Math.acos(Math.max(-1, Math.min(1, pz)));
  let m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (al > 1e-15) {
    ax /= al;
    ay /= al;
    const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    // Rodrigues with axis (ax, ay, 0)
    m = [
      t * ax * ax + c, t * ax * ay, s * ay,
      t * ax * ay, t * ay * ay + c, -s * ax,
      -s * ay, s * ax, c,
    ];
  }
  const coords = new Float64Array(2 * (n - 1));
  for (let i = 1; i < n; i++) {
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    const rx = m[0] * x + m[1] * y + m[2] * z;
    const ry = m[3] * x + m[4] * y + m[5] * z;
    const rz = m[6] * x + m[7] * y + m[8] * z;
    const k = 1 / Math.max(1e-12, 1 - rz);
    coords[2 * (i - 1)] = rx * k;
    coords[2 * (i - 1) + 1] = ry * k;
  }
  const d = new Delaunator(coords);
  const nt = d.triangles.length / 3;
  const hull = d.hull;
  const total = nt + hull.length;
  const tris = new Int32Array(total * 3);
  for (let t = 0; t < nt; t++) {
    tris[3 * t] = d.triangles[3 * t] + 1;
    tris[3 * t + 1] = d.triangles[3 * t + 1] + 1;
    tris[3 * t + 2] = d.triangles[3 * t + 2] + 1;
  }
  for (let h = 0; h < hull.length; h++) {
    const a = hull[h] + 1;
    const b = hull[(h + 1) % hull.length] + 1;
    const t = nt + h;
    tris[3 * t] = a;
    tris[3 * t + 1] = b;
    tris[3 * t + 2] = 0;
  }
  // Orient all triangles CCW seen from outside: det(a, b, c) > 0.
  for (let t = 0; t < total; t++) {
    const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
    const ax_ = xyz[3 * a], ay_ = xyz[3 * a + 1], az_ = xyz[3 * a + 2];
    const bx = xyz[3 * b], by = xyz[3 * b + 1], bz = xyz[3 * b + 2];
    const cx = xyz[3 * c], cy = xyz[3 * c + 1], cz = xyz[3 * c + 2];
    const det = ax_ * (by * cz - bz * cy) + ay_ * (bz * cx - bx * cz) + az_ * (bx * cy - by * cx);
    if (det < 0) {
      tris[3 * t + 1] = c;
      tris[3 * t + 2] = b;
    }
  }
  return tris;
}

function buildAdjacency(tris: Int32Array, n: number, xyz: Float64Array): { adjOffset: Int32Array; adj: Int32Array } {
  // Each CCW triangle (a,b,c) contributes, around vertex a, the ordered pair b -> c.
  const nt = tris.length / 3;
  const deg = new Int32Array(n);
  for (let k = 0; k < tris.length; k++) deg[tris[k]]++;
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
  const from = new Int32Array(off[n]);
  const to = new Int32Array(off[n]);
  const fill = off.slice(0, n);
  for (let t = 0; t < nt; t++) {
    const v0 = tris[3 * t], v1 = tris[3 * t + 1], v2 = tris[3 * t + 2];
    let p = fill[v0]++;
    from[p] = v1; to[p] = v2;
    p = fill[v1]++;
    from[p] = v2; to[p] = v0;
    p = fill[v2]++;
    from[p] = v0; to[p] = v1;
  }
  const adj = new Int32Array(off[n]);
  for (let i = 0; i < n; i++) {
    const s = off[i], e = off[i + 1];
    const d = e - s;
    // Chain the successor pairs into a CCW cycle.
    let cur = from[s];
    let ok = true;
    for (let k = 0; k < d; k++) {
      adj[s + k] = cur;
      let next = -1;
      for (let q = s; q < e; q++) {
        if (from[q] === cur) {
          next = to[q];
          break;
        }
      }
      if (next < 0) {
        ok = false;
        break;
      }
      cur = next;
    }
    if (!ok) {
      // Fallback (should not happen for a valid closed triangulation): unique neighbors sorted by angle.
      const set = new Set<number>();
      for (let q = s; q < e; q++) {
        set.add(from[q]);
        set.add(to[q]);
      }
      const arr = [...set];
      const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
      let ex = -py, ey = px;
      const el = Math.hypot(ex, ey) || 1;
      ex /= el; ey /= el;
      const nx = py * 0 - pz * ey, ny = pz * ex - px * 0, nz = px * ey - py * ex;
      arr.sort((u, v) => {
        const au = Math.atan2(xyz[3 * u] * nx + xyz[3 * u + 1] * ny + xyz[3 * u + 2] * nz, xyz[3 * u] * ex + xyz[3 * u + 1] * ey);
        const av = Math.atan2(xyz[3 * v] * nx + xyz[3 * v + 1] * ny + xyz[3 * v + 2] * nz, xyz[3 * v] * ex + xyz[3 * v + 1] * ey);
        return au - av;
      });
      for (let k = 0; k < d && k < arr.length; k++) adj[s + k] = arr[k];
    }
  }
  return { adjOffset: off, adj };
}

function buildLut(mesh: SphereMesh): void {
  const { lutW, lutH, lut } = mesh;
  let rowStart = 0;
  for (let r = 0; r < lutH; r++) {
    const la = Math.PI / 2 - ((r + 0.5) * Math.PI) / lutH;
    const cl = Math.cos(la), sl = Math.sin(la);
    let hint = rowStart;
    for (let c = 0; c < lutW; c++) {
      const lo = -Math.PI + ((c + 0.5) * 2 * Math.PI) / lutW;
      const v = walk(mesh, cl * Math.cos(lo), cl * Math.sin(lo), sl, hint);
      lut[r * lutW + c] = v;
      hint = v;
      if (c === 0) rowStart = v;
    }
  }
}

/** Greedy steepest-ascent walk on the Delaunay graph; exact nearest neighbor on a Delaunay triangulation. */
function walk(mesh: SphereMesh, x: number, y: number, z: number, start: number): number {
  const { xyz, adjOffset, adj } = mesh;
  let cur = start;
  let best = xyz[3 * cur] * x + xyz[3 * cur + 1] * y + xyz[3 * cur + 2] * z;
  for (;;) {
    let next = -1;
    const e = adjOffset[cur + 1];
    for (let k = adjOffset[cur]; k < e; k++) {
      const j = adj[k];
      const d = xyz[3 * j] * x + xyz[3 * j + 1] * y + xyz[3 * j + 2] * z;
      if (d > best) {
        best = d;
        next = j;
      }
    }
    if (next < 0) return cur;
    cur = next;
  }
}

/** Starting guess from the lookup table. */
function lutGuess(mesh: SphereMesh, x: number, y: number, z: number): number {
  const r = Math.hypot(x, y, z) || 1;
  const la = Math.asin(Math.max(-1, Math.min(1, z / r)));
  const lo = Math.atan2(y, x);
  let row = Math.floor(((Math.PI / 2 - la) / Math.PI) * mesh.lutH);
  if (row < 0) row = 0;
  else if (row >= mesh.lutH) row = mesh.lutH - 1;
  let col = Math.floor(((lo + Math.PI) / (2 * Math.PI)) * mesh.lutW);
  if (col < 0) col += mesh.lutW;
  if (col >= mesh.lutW) col -= mesh.lutW;
  return mesh.lut[row * mesh.lutW + col];
}

/**
 * Index of the mesh cell nearest to direction (x,y,z) (need not be normalized). EXACT (ties
 * broken arbitrarily). `hint` (a cell index near the answer) makes it faster.
 */
export function nearestCell(mesh: SphereMesh, x: number, y: number, z: number, hint?: number): number {
  const start = hint !== undefined && hint >= 0 && hint < mesh.n ? hint : lutGuess(mesh, x, y, z);
  return walk(mesh, x, y, z, start);
}

const visitStamp = new WeakMap<SphereMesh, { stamp: Int32Array; gen: number }>();

/** All cells whose centers are within `radius` radians of `center` (unit vector). Order unspecified. */
export function cellsWithinRadius(mesh: SphereMesh, center: Vec3, radius: number, out: number[] = []): number[] {
  out.length = 0;
  const [cx, cy, cz] = center;
  const cl = Math.hypot(cx, cy, cz) || 1;
  const x = cx / cl, y = cy / cl, z = cz / cl;
  const start = nearestCell(mesh, x, y, z);
  const cosR = Math.cos(Math.min(Math.PI, Math.max(0, radius)));
  // Expand through a slightly larger margin so the in-radius set is reached even where the
  // induced subgraph would be disconnected.
  const cosM = Math.cos(Math.min(Math.PI, Math.max(0, radius) + 1.5 * mesh.spacing));
  let vs = visitStamp.get(mesh);
  if (!vs) {
    vs = { stamp: new Int32Array(mesh.n), gen: 0 };
    visitStamp.set(mesh, vs);
  }
  vs.gen++;
  if (vs.gen >= 0x7fffffff) {
    vs.stamp.fill(0);
    vs.gen = 1;
  }
  const gen = vs.gen;
  const stamp = vs.stamp;
  const { xyz, adjOffset, adj } = mesh;
  const queue: number[] = [start];
  stamp[start] = gen;
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const d = xyz[3 * i] * x + xyz[3 * i + 1] * y + xyz[3 * i + 2] * z;
    if (d >= cosR) out.push(i);
    const e = adjOffset[i + 1];
    for (let k = adjOffset[i]; k < e; k++) {
      const j = adj[k];
      if (stamp[j] === gen) continue;
      stamp[j] = gen;
      const dj = xyz[3 * j] * x + xyz[3 * j + 1] * y + xyz[3 * j + 2] * z;
      if (dj >= cosM) queue.push(j);
    }
  }
  return out;
}

/** Neighbors of cell i (a view into mesh.adj). */
export function neighborsOf(mesh: SphereMesh, i: number): Int32Array {
  return mesh.adj.subarray(mesh.adjOffset[i], mesh.adjOffset[i + 1]);
}

const vertexTriCache = new WeakMap<SphereMesh, { off: Int32Array; tri: Int32Array }>();

/** CSR vertex -> incident triangle indices (lazily built, cached per mesh). Core-internal helper. */
export function vertexTriangles(mesh: SphereMesh): { off: Int32Array; tri: Int32Array } {
  let vt = vertexTriCache.get(mesh);
  if (vt) return vt;
  const { n, triangles } = mesh;
  const off = new Int32Array(n + 1);
  for (let k = 0; k < triangles.length; k++) off[triangles[k] + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const fill = off.slice(0, n);
  const tri = new Int32Array(triangles.length);
  for (let k = 0; k < triangles.length; k++) tri[fill[triangles[k]]++] = (k / 3) | 0;
  vt = { off, tri };
  vertexTriCache.set(mesh, vt);
  return vt;
}
