import { EARTH_RADIUS_KM } from '../core/constants';
import type { SphereMesh, Vec3 } from '../core/types';

// Per-cell plate-boundary kinematics from the plates' angular velocities: for every cell that touches
// another plate, the opening / closing rate (km/Myr) against each neighbouring plate along the
// boundary normal. The normal is estimated over a few rings, n = Σ w_j (p_j − p_i) with w = +1 on the
// other plate and −1 on this plate (the simulation's estimator, over a wider neighbourhood), which is
// far less noisy than per-edge normals along ragged boundaries (no spurious "ridge" beads).

export interface BoundaryKinematics {
  /** 1 where the cell has a neighbour on another plate. */
  isBoundary: Uint8Array;
  /** Opening (divergence) rate, km/Myr (0 if closing or not a boundary). Smoothed along the boundary. */
  diverge: Float32Array;
  /** Closing (convergence) rate, km/Myr (0 if opening or not a boundary). Smoothed along the boundary. */
  converge: Float32Array;
  /** Neighbouring plate with the fastest closing rate before smoothing (-1 if none). */
  convergePlate: Int16Array;
  /** A neighbouring cell on `convergePlate` (-1 if none), e.g. to read the crust type across the front. */
  convergeCell: Int32Array;
  /** Relative plate speed |v_b − v_a| (km/Myr) for the dominant neighbour, smoothed along the boundary. */
  relSpeed: Float32Array;
}

/**
 * True when the boundary at cell i is mostly normal (opening or closing) rather than strike-slip:
 * |normal rate| ≥ 0.3·|relative velocity| (motion within ~72° of the boundary normal).
 */
export function isNormalDominated(kin: BoundaryKinematics, i: number): boolean {
  return Math.max(kin.diverge[i], kin.converge[i]) >= 0.3 * kin.relSpeed[i];
}

const MAX_NEIGHBOR_PLATES = 8;
/**
 * Rings used for the boundary normal: ~4 cell spacings (≈ 300 km at 100k cells) so the normal follows
 * the large-scale boundary trend rather than cell-scale wiggles (which would flip oblique boundaries
 * between opening and closing every few cells).
 */
const NORMAL_RINGS = 4;
/** Passes of along-boundary averaging applied to the signed normal rate. */
const SMOOTH_PASSES = 3;

/**
 * Average the signed normal rate (opening > 0) over adjacent boundary cells, so oblique boundaries
 * read as consistently (slowly) opening or closing instead of flickering around the thresholds.
 */
function smoothAlongBoundaries(mesh: SphereMesh, isBoundary: Uint8Array, rate: Float32Array): void {
  // (Also used for the relative-speed magnitude.)
  const { n, adjOffset, adj } = mesh;
  const tmp = new Float32Array(n);
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    for (let i = 0; i < n; i++) {
      if (!isBoundary[i]) continue;
      let s = rate[i], c = 1;
      for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
        const j = adj[e];
        if (isBoundary[j]) { s += rate[j]; c++; }
      }
      tmp[i] = s / c;
    }
    for (let i = 0; i < n; i++) if (isBoundary[i]) rate[i] = tmp[i];
  }
}

export function boundaryKinematics(mesh: SphereMesh, plate: Int16Array, omega: Vec3[]): BoundaryKinematics {
  const { n, xyz, adjOffset, adj } = mesh;
  const isBoundary = new Uint8Array(n);
  const diverge = new Float32Array(n);
  const converge = new Float32Array(n);
  const convergePlate = new Int16Array(n).fill(-1);
  const convergeCell = new Int32Array(n).fill(-1);
  const relSpeed = new Float32Array(n);
  const dominant = new Float32Array(n);
  const pl = new Int32Array(MAX_NEIGHBOR_PLATES);
  const cellOf = new Int32Array(MAX_NEIGHBOR_PLATES);
  const ring: number[] = [];
  const stamp = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const a = plate[i];
    // Distinct neighbouring plates in the 1-ring.
    let m = 0;
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      const b = plate[adj[e]];
      if (b === a) continue;
      let s = 0;
      while (s < m && pl[s] !== b) s++;
      if (s === m && m < MAX_NEIGHBOR_PLATES) {
        pl[m] = b;
        cellOf[m] = adj[e];
        m++;
      }
    }
    if (m === 0) continue;
    isBoundary[i] = 1;
    // Gather the NORMAL_RINGS-ring neighbourhood (excluding i) by BFS.
    ring.length = 0;
    stamp[i] = i;
    let head = 0;
    ring.push(i);
    for (let r = 0; r < NORMAL_RINGS; r++) {
      const end = ring.length;
      for (; head < end; head++) {
        const c = ring[head];
        for (let e = adjOffset[c]; e < adjOffset[c + 1]; e++) {
          const j = adj[e];
          if (stamp[j] !== i) { stamp[j] = i; ring.push(j); }
        }
      }
    }
    const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
    const wa = omega[a];
    for (let s = 0; s < m; s++) {
      const b = pl[s];
      let nx = 0, ny = 0, nz = 0;
      for (const j of ring) {
        const w = plate[j] === b ? 1 : plate[j] === a ? -1 : 0;
        if (w === 0) continue;
        nx += w * (xyz[3 * j] - px);
        ny += w * (xyz[3 * j + 1] - py);
        nz += w * (xyz[3 * j + 2] - pz);
      }
      const d = nx * px + ny * py + nz * pz;
      nx -= d * px; ny -= d * py; nz -= d * pz;
      let l = Math.hypot(nx, ny, nz);
      if (l < 1e-9) {
        // Symmetric neighbourhood: fall back to the direction of one neighbour on plate b.
        const j = cellOf[s];
        nx = xyz[3 * j] - px; ny = xyz[3 * j + 1] - py; nz = xyz[3 * j + 2] - pz;
        const dj = nx * px + ny * py + nz * pz;
        nx -= dj * px; ny -= dj * py; nz -= dj * pz;
        l = Math.hypot(nx, ny, nz) || 1;
      }
      nx /= l; ny /= l; nz /= l;
      const wb = omega[b];
      const wx = wb[0] - wa[0], wy = wb[1] - wa[1], wz = wb[2] - wa[2];
      // Velocity of plate b relative to plate a at p_i: (ω_b − ω_a) × p, km/Myr; > 0 along n = opening.
      const vx = (wy * pz - wz * py) * EARTH_RADIUS_KM, vy = (wz * px - wx * pz) * EARTH_RADIUS_KM, vz = (wx * py - wy * px) * EARTH_RADIUS_KM;
      const vn = vx * nx + vy * ny + vz * nz;
      if (Math.abs(vn) >= dominant[i]) {
        dominant[i] = Math.abs(vn);
        relSpeed[i] = Math.hypot(vx, vy, vz);
      }
      if (vn > diverge[i]) diverge[i] = vn;
      if (-vn > converge[i]) {
        converge[i] = -vn;
        convergePlate[i] = b;
        convergeCell[i] = cellOf[s];
      }
    }
  }
  // Net signed rate per cell (the dominant of opening vs closing), smoothed along the boundary.
  const rate = new Float32Array(n);
  for (let i = 0; i < n; i++) rate[i] = diverge[i] >= converge[i] ? diverge[i] : -converge[i];
  smoothAlongBoundaries(mesh, isBoundary, rate);
  smoothAlongBoundaries(mesh, isBoundary, relSpeed);
  for (let i = 0; i < n; i++) {
    diverge[i] = Math.max(0, rate[i]);
    converge[i] = Math.max(0, -rate[i]);
  }
  return { isBoundary, diverge, converge, convergePlate, convergeCell, relSpeed };
}
