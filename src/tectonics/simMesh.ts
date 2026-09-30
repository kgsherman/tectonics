import { EARTH_RADIUS_KM } from '../core/constants';
import { vertexTriangles } from '../core/sphereMesh';
import type { SphereMesh } from '../core/types';

/** Gaussian width of the boundary-normal kernel, in cell spacings. */
export const NORMAL_SIGMA_SPACINGS = 1.2;
/** Graph radius of the neighbourhood disk (rings). */
const DISK_RINGS = 3;

/** Mesh-derived lookup tables used by the simulation (built once per mesh, cached). */
export interface SimMesh {
  readonly mesh: SphereMesh;
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

function buildSimMesh(mesh: SphereMesh): SimMesh {
  const disk = buildDisk(mesh);
  const vt = vertexTriangles(mesh);
  return {
    mesh,
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
  };
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
