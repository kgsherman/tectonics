import { EARTH_RADIUS_KM } from '../core/constants';
import { vertexTriangles } from '../core/sphereMesh';
import type { SphereMesh } from '../core/types';

/** Gaussian width of the boundary-normal kernel, in cell spacings. */
export const NORMAL_SIGMA_SPACINGS = 1.2;
/** Graph radius of the neighbourhood disk (rings). */
const DISK_RINGS = 3;

/**
 * Mesh-derived lookup tables used by the simulation (built once per mesh, cached).
 *
 * Internal numbering: the simulation works on a spatially renumbered copy of the caller's mesh
 * (cells sorted along a Hilbert curve on the cube faces). The Fibonacci numbering scatters spatial
 * neighbourhoods across memory, and once plates have rotated by large angles every world ↔ plate
 * frame lookup became a cache miss; with coherent numbering a compact patch in one frame is a
 * compact index range in the other (≈ 40% faster steps, and no slowdown late in long runs). Every
 * per-cell sim array uses the internal numbering; drafts and snapshots are converted at the API
 * boundary (`toInt` / `toExt`).
 */
export interface SimMesh {
  /** Internal (renumbered) mesh: a complete SphereMesh whose cell k is external cell toExt[k]. */
  readonly mesh: SphereMesh;
  /** The caller's mesh (external numbering: drafts, snapshots, plate infos). */
  readonly ext: SphereMesh;
  /** Internal cell → external cell, and external → internal. */
  readonly toExt: Int32Array;
  readonly toInt: Int32Array;
  readonly n: number;
  readonly xyz: Float64Array;
  readonly adjOffset: Int32Array;
  readonly adj: Int32Array;
  /**
   * Neighbourhood disk of each cell (rings 1..3, excluding the cell), CSR sorted by ring:
   * entries [diskOffset[i], ring2End[i]) are rings 1–2, [ring2End[i], diskOffset[i+1]) ring 3.
   */
  readonly diskOffset: Int32Array;
  readonly ring2End: Int32Array;
  readonly disk: Int32Array;
  /** Gaussian weight exp(−d²/2σ²) of each disk entry (σ = NORMAL_SIGMA_SPACINGS · spacing). */
  readonly diskW: Float32Array;
  /** Σ w·|s_a − s_i| over the disk: the normal length a perfect straight boundary would approach. */
  readonly diskMoment: Float32Array;
  /** Great-circle length of every adjacency entry, km. */
  readonly edgeKm: Float32Array;
  /** Mean neighbour spacing, km. */
  readonly spacingKm: number;
  /** Area of one cell, km². */
  readonly cellAreaKm2: number;
  /** Vertex → incident triangles (CSR). */
  readonly vtOff: Int32Array;
  readonly vtTri: Int32Array;
  /**
   * cos of (slightly less than) the inscribed radius of each cell's Voronoi region, i.e. half the
   * angle to its nearest neighbour: a unit direction p with p·s_i > cosIn[i] has cell i as its exact
   * nearest lattice point (early exit of the nearest-cell walk, no neighbour scan needed).
   */
  readonly cosIn: Float64Array;
}

const cache = new WeakMap<SphereMesh, SimMesh>();

export function simMeshOf(mesh: SphereMesh): SimMesh {
  let sm = cache.get(mesh);
  if (!sm) {
    sm = buildSimMesh(mesh);
    cache.set(mesh, sm);
  }
  return sm;
}

/** 2D Hilbert-curve index of (x, y) on a 2^order square grid. */
function hilbert2(x: number, y: number, order: number): number {
  let d = 0;
  for (let s = 1 << (order - 1); s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

/** Locality key of a unit vector: cube face (major), then the Hilbert index within the face. */
function localityKey(x: number, y: number, z: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let f: number, u: number, v: number;
  if (ax >= ay && ax >= az) {
    f = x > 0 ? 0 : 1;
    u = y / ax;
    v = z / ax;
  } else if (ay >= az) {
    f = y > 0 ? 2 : 3;
    u = x / ay;
    v = z / ay;
  } else {
    f = z > 0 ? 4 : 5;
    u = x / az;
    v = y / az;
  }
  const order = 12;
  const N = 1 << order;
  const qu = Math.min(N - 1, Math.max(0, Math.floor(((u + 1) / 2) * N)));
  const qv = Math.min(N - 1, Math.max(0, Math.floor(((v + 1) / 2) * N)));
  return f * N * N + hilbert2(qu, qv, order);
}

/** The caller's mesh renumbered along the locality curve (see SimMesh). */
function renumberedMesh(ext: SphereMesh): { mesh: SphereMesh; toExt: Int32Array; toInt: Int32Array } {
  const n = ext.n;
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) keys[i] = localityKey(ext.xyz[3 * i], ext.xyz[3 * i + 1], ext.xyz[3 * i + 2]);
  const toExt = new Int32Array(n);
  for (let i = 0; i < n; i++) toExt[i] = i;
  toExt.sort((a, b) => keys[a] - keys[b] || a - b);
  const toInt = new Int32Array(n);
  for (let k = 0; k < n; k++) toInt[toExt[k]] = k;
  const xyz = new Float64Array(3 * n);
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);
  const adjOffset = new Int32Array(n + 1);
  const adj = new Int32Array(ext.adj.length);
  let w = 0;
  for (let k = 0; k < n; k++) {
    const o = toExt[k];
    xyz[3 * k] = ext.xyz[3 * o];
    xyz[3 * k + 1] = ext.xyz[3 * o + 1];
    xyz[3 * k + 2] = ext.xyz[3 * o + 2];
    lat[k] = ext.lat[o];
    lon[k] = ext.lon[o];
    adjOffset[k] = w;
    for (let q = ext.adjOffset[o], e = ext.adjOffset[o + 1]; q < e; q++) adj[w++] = toInt[ext.adj[q]];
  }
  adjOffset[n] = w;
  const triangles = new Int32Array(ext.triangles.length);
  for (let q = 0; q < triangles.length; q++) triangles[q] = toInt[ext.triangles[q]];
  const lut = new Int32Array(ext.lut.length);
  for (let q = 0; q < lut.length; q++) lut[q] = toInt[ext.lut[q]];
  const mesh: SphereMesh = {
    n, xyz, lat, lon, adjOffset, adj, triangles, spacing: ext.spacing, cellArea: ext.cellArea,
    lutW: ext.lutW, lutH: ext.lutH, lut,
  };
  return { mesh, toExt, toInt };
}

function buildSimMesh(ext: SphereMesh): SimMesh {
  const { mesh, toExt, toInt } = renumberedMesh(ext);
  const disk = buildDisk(mesh);
  const vt = vertexTriangles(mesh);
  return {
    mesh,
    ext,
    toExt,
    toInt,
    n: mesh.n,
    xyz: mesh.xyz,
    adjOffset: mesh.adjOffset,
    adj: mesh.adj,
    ...disk,
    edgeKm: buildEdgeLengths(mesh),
    spacingKm: mesh.spacing * EARTH_RADIUS_KM,
    cellAreaKm2: mesh.cellArea * EARTH_RADIUS_KM * EARTH_RADIUS_KM,
    vtOff: vt.off,
    vtTri: vt.tri,
    cosIn: buildInscribed(mesh),
  };
}

/**
 * Inscribed-disk test values (see SimMesh.cosIn). The nearest other lattice point is always a Delaunay
 * neighbour, so a point closer to s_i than half that distance is strictly nearest to i. The radius is
 * shrunk by 1e-6 (relative) so rounding in the dot product can never admit a tie.
 */
function buildInscribed(mesh: SphereMesh): Float64Array {
  const { n, xyz, adjOffset, adj } = mesh;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    let maxDot = -1;
    for (let q = adjOffset[i]; q < adjOffset[i + 1]; q++) {
      const a = adj[q];
      const d = x * xyz[3 * a] + y * xyz[3 * a + 1] + z * xyz[3 * a + 2];
      if (d > maxDot) maxDot = d;
    }
    const r = 0.5 * Math.acos(Math.max(-1, Math.min(1, maxDot)));
    out[i] = Math.cos(r * (1 - 1e-6));
  }
  return out;
}

/** Breadth-first rings 1..DISK_RINGS of every cell with Gaussian weights. */
function buildDisk(mesh: SphereMesh): Pick<SimMesh, 'diskOffset' | 'ring2End' | 'disk' | 'diskW' | 'diskMoment'> {
  const { n, xyz, adjOffset, adj } = mesh;
  const stamp = new Int32Array(n).fill(-1);
  const diskOffset = new Int32Array(n + 1);
  const ring2End = new Int32Array(n);
  let cap = n * 40;
  let disk = new Int32Array(cap);
  let w = 0;
  const frontier: number[] = [];
  const next: number[] = [];
  for (let i = 0; i < n; i++) {
    diskOffset[i] = w;
    stamp[i] = i;
    frontier.length = 0;
    frontier.push(i);
    for (let ring = 1; ring <= DISK_RINGS; ring++) {
      next.length = 0;
      for (const c of frontier) {
        for (let q = adjOffset[c]; q < adjOffset[c + 1]; q++) {
          const a = adj[q];
          if (stamp[a] === i) continue;
          stamp[a] = i;
          next.push(a);
        }
      }
      if (w + next.length > cap) {
        cap *= 2;
        const d2 = new Int32Array(cap);
        d2.set(disk);
        disk = d2;
      }
      for (const a of next) disk[w++] = a;
      if (ring === 2) ring2End[i] = w;
      frontier.length = 0;
      for (const a of next) frontier.push(a);
    }
  }
  diskOffset[n] = w;
  disk = disk.slice(0, w);
  const diskW = new Float32Array(w);
  const diskMoment = new Float32Array(n);
  const s2 = 2 * (NORMAL_SIGMA_SPACINGS * mesh.spacing) ** 2;
  for (let i = 0; i < n; i++) {
    let moment = 0;
    for (let q = diskOffset[i]; q < diskOffset[i + 1]; q++) {
      const a = disk[q];
      const dx = xyz[3 * a] - xyz[3 * i], dy = xyz[3 * a + 1] - xyz[3 * i + 1], dz = xyz[3 * a + 2] - xyz[3 * i + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      const wt = Math.exp(-d2 / s2);
      diskW[q] = wt;
      moment += wt * Math.sqrt(d2);
    }
    diskMoment[i] = moment;
  }
  return { diskOffset, ring2End, disk, diskW, diskMoment };
}

function buildEdgeLengths(mesh: SphereMesh): Float32Array {
  const { n, xyz, adjOffset, adj } = mesh;
  const edgeKm = new Float32Array(adj.length);
  for (let i = 0; i < n; i++) {
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      const j = adj[k];
      const cx = y * xyz[3 * j + 2] - z * xyz[3 * j + 1];
      const cy = z * xyz[3 * j] - x * xyz[3 * j + 2];
      const cz = x * xyz[3 * j + 1] - y * xyz[3 * j];
      const d = x * xyz[3 * j] + y * xyz[3 * j + 1] + z * xyz[3 * j + 2];
      edgeKm[k] = Math.atan2(Math.hypot(cx, cy, cz), d) * EARTH_RADIUS_KM;
    }
  }
  return edgeKm;
}

/**
 * Nearest lattice cell to the unit direction (x, y, z), walking greedily from `start` (a nearby
 * cell). Identical result to walkNearest, but a cell whose inscribed disk contains the point is
 * accepted without scanning its neighbours (≈ 3/4 of all queries after one substep of motion).
 */
export function walkFrom(sm: SimMesh, x: number, y: number, z: number, start: number): number {
  const { xyz, adjOffset, adj, cosIn } = sm;
  let cur = start;
  let best = xyz[3 * cur] * x + xyz[3 * cur + 1] * y + xyz[3 * cur + 2] * z;
  for (;;) {
    if (best > cosIn[cur]) return cur;
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

/**
 * Greedy walk on the Delaunay graph toward direction (x, y, z): returns the exact nearest lattice
 * cell (greedy routing is exact on a Delaunay triangulation). `start` should be a nearby cell.
 */
export function walkNearest(
  xyz: Float64Array, adjOffset: Int32Array, adj: Int32Array, x: number, y: number, z: number, start: number,
): number {
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
