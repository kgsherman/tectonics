/**
 * Solver for the Stommel system set up in oceanStommel.ts: one relaxation sweep (red-black zonal
 * line relaxation with over-relaxation, island super-node Gauss–Seidel and the row/island block
 * correction) used as the right preconditioner of restarted GMRES.
 */
import { EARTH_RADIUS_M } from './dynGrid';
import { makeCyclicWork, solveCyclic, solveTridiag, type CyclicWork } from './numerics';
import { applyBlockCorrection } from './oceanBlock';
import type { StommelSetup } from './oceanStommel';
import { oceanTuning } from './tuning';

export interface StommelWork {
  /** Line-solve buffers (length nx). */
  a: Float64Array;
  b: Float64Array;
  c: Float64Array;
  d: Float64Array;
  x: Float64Array;
  cp: Float64Array;
  cyc: CyclicWork;
  /** GMRES: Krylov basis V (m+1), preconditioned directions Z (m), Hessenberg H (m×m), Givens, rhs. */
  V: Float64Array[];
  Z: Float64Array[];
  H: Float64Array;
  cs: Float64Array;
  sn: Float64Array;
  gv: Float64Array;
  y: Float64Array;
  rb: Float64Array;
  r: Float64Array;
  dx: Float64Array;
  isl: Float64Array;
  /** 1 for wet cells and for the first cell of each island (inner-product support). */
  wmask: Uint8Array;
}

/** Krylov subspace size between GMRES restarts. */
const GMRES_RESTART = 16;
/** Residual tolerance factor (≈ 1/L² for basin-scale errors of L ≈ 15 cells). */
const RES_TOL_FACTOR = 0.005;

export function makeStommelWork(S: StommelSetup): StommelWork {
  const { nx, n } = S.g;
  const f = (): Float64Array => new Float64Array(n);
  const wmask = new Uint8Array(n);
  for (let i = 0; i < n; i++) wmask[i] = S.wet[i];
  for (let k = 0; k < S.nIslands; k++) wmask[S.islCells[S.islCellOff[k]]] = 1;
  return {
    a: new Float64Array(nx), b: new Float64Array(nx), c: new Float64Array(nx), d: new Float64Array(nx),
    x: new Float64Array(nx), cp: new Float64Array(nx), cyc: makeCyclicWork(nx),
    V: Array.from({ length: GMRES_RESTART + 1 }, f), Z: Array.from({ length: GMRES_RESTART }, f),
    H: new Float64Array(GMRES_RESTART * GMRES_RESTART), cs: new Float64Array(GMRES_RESTART), sn: new Float64Array(GMRES_RESTART),
    gv: new Float64Array(GMRES_RESTART + 1), y: new Float64Array(GMRES_RESTART), rb: f(), r: f(), dx: f(),
    isl: new Float64Array(S.nIslands), wmask,
  };
}

/*
 * Vector layouts (full grid, length n):
 *  - "solution" vectors hold Ψ at wet cells, the island level at every cell of an island and 0 on
 *    the main component;
 *  - "residual" vectors hold equation values at wet cells and each island's circulation equation
 *    at the island's first cell (0 elsewhere).
 */

function islandValues(S: StommelSetup, res: Float64Array, out: Float64Array): void {
  for (let k = 0; k < S.nIslands; k++) out[k] = res[S.islCells[S.islCellOff[k]]];
}

/** Residual-layout right-hand side: per-cell values at wet cells, island sums at island first cells. */
function residualLayoutRhs(S: StommelSetup, rhs: Float64Array, out: Float64Array): void {
  const { wet } = S;
  for (let i = 0; i < out.length; i++) out[i] = wet[i] ? rhs[i] : 0;
  for (let k = 0; k < S.nIslands; k++) {
    let sum = 0;
    for (let q = S.islCellOff[k]; q < S.islCellOff[k + 1]; q++) sum += rhs[S.islCells[q]];
    out[S.islCells[S.islCellOff[k]]] = sum;
  }
}

/** y = A·x (x solution layout → y residual layout). */
function applyOperator(S: StommelSetup, x: Float64Array, y: Float64Array): void {
  const { g, j0, j1, wet, r, ax, an, as, bw } = S;
  const { nx } = g;
  y.fill(0);
  for (let j = j0; j <= j1; j++) {
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (!wet[i]) continue;
      const iw = j * nx + (c === 0 ? nx - 1 : c - 1);
      const ie = j * nx + (c === nx - 1 ? 0 : c + 1);
      const p = x[i];
      const pe = x[ie], pw = x[iw];
      const fe = wet[ie] ? 0.5 * (p + pe) : pe;
      const fw = wet[iw] ? 0.5 * (p + pw) : pw;
      y[i] = r * (ax[j] * (pe + pw - 2 * p) + an[j] * (x[i - nx] - p) + as[j] * (x[i + nx] - p)) + 2 * bw[j] * (fe - fw);
    }
  }
  for (let k = 0; k < S.nIslands; k++) {
    const first = S.islCells[S.islCellOff[k]];
    const pk = x[first];
    let v = 0;
    for (let q = S.islFaceOff[k]; q < S.islFaceOff[k + 1]; q++) v += S.islFaceCoef[q] * (x[S.islFaceCell[q]] - pk);
    y[first] = r * v;
  }
}

/**
 * One relaxation sweep on A·Ψ = b (b residual layout, Ψ solution layout, updated in place):
 * red-black zonal line solves with over-relaxation, island super-node Gauss–Seidel, then the
 * coarse row/island block correction.
 */
function relaxSweep(S: StommelSetup, b: Float64Array, psi: Float64Array, work: StommelWork): void {
  const { g, j0, j1, wet, r, ax, an, as, bw, diag, lo, up, segOff, segStart, segLen, segPeriodic } = S;
  const { nx } = g;
  const omegaSor = oceanTuning.sorOmega;
  const { a, b: bb, c: cc, d, x, cp, cyc, isl } = work;
  for (let color = 0; color < 2; color++) {
    for (let j = j0 + color; j <= j1; j += 2) {
      const rax = r * ax[j], ran = r * an[j], ras = r * as[j], bwj = bw[j];
      for (let s = segOff[j]; s < segOff[j + 1]; s++) {
        const start = segStart[s];
        const len = segLen[s];
        for (let k = 0; k < len; k++) {
          const col = (start + k) % nx;
          const i = j * nx + col;
          let rr = b[i] - ran * psi[i - nx] - ras * psi[i + nx];
          const iw = j * nx + (col === 0 ? nx - 1 : col - 1);
          const ie = j * nx + (col === nx - 1 ? 0 : col + 1);
          if (!wet[iw]) rr -= (rax - 2 * bwj) * psi[iw];
          if (!wet[ie]) rr -= (rax + 2 * bwj) * psi[ie];
          a[k] = lo[i];
          bb[k] = diag[i];
          cc[k] = up[i];
          d[k] = rr;
        }
        if (segPeriodic[s] && len >= 3) solveCyclic(a, bb, cc, d, x, len, cyc);
        else solveTridiag(a, bb, cc, d, x, len, cp);
        for (let k = 0; k < len; k++) {
          const i = j * nx + ((start + k) % nx);
          psi[i] += omegaSor * (x[k] - psi[i]);
        }
      }
    }
  }
  // Island super-nodes (Gauss–Seidel): Ψ_k = (Σ a_f Ψ_nb − b_k / r) / Σ a_f.
  islandValues(S, b, isl);
  for (let k = 0; k < S.nIslands; k++) {
    let sa = 0;
    let sp = 0;
    for (let q = S.islFaceOff[k]; q < S.islFaceOff[k + 1]; q++) {
      sa += S.islFaceCoef[q];
      sp += S.islFaceCoef[q] * psi[S.islFaceCell[q]];
    }
    if (sa <= 0) continue;
    const nv = (sp - isl[k] / r) / sa;
    for (let q = S.islCellOff[k]; q < S.islCellOff[k + 1]; q++) psi[S.islCells[q]] = nv;
  }
  applyBlockCorrection(S, S.block, b, isl, psi);
}

/** Dot product of residual-layout vectors (entries outside the mask are zero by construction). */
function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** z = M⁻¹·y: one relaxation sweep on A·z = y from z = 0. */
function precondition(S: StommelSetup, y: Float64Array, z: Float64Array, work: StommelWork): void {
  z.fill(0);
  relaxSweep(S, y, z, work);
}

/**
 * Solve for Ψ (solution layout, warm start in place) with the cell-integrated right-hand side
 * `rhs` (m³/s² per cell): restarted GMRES right-preconditioned by one line-relaxation sweep (the
 * β term makes the preconditioned spectrum complex, where GMRES is robust). Each preconditioner
 * application counts as one sweep. Stops when a restart cycle changes the surface velocity by less
 * than tolU (m/s) or the residual reaches round-off. Returns sweeps used and the last max |Δu|.
 */
export function solveStommel(
  S: StommelSetup,
  rhs: Float64Array,
  psi: Float64Array,
  maxSweeps: number,
  tolU: number,
  work: StommelWork,
): { sweeps: number; maxDu: number } {
  const { wet, comp, g } = S;
  const n = g.n;
  const uScale = 1 / (oceanTuning.effectiveDepth * EARTH_RADIUS_M * g.dLat);
  const { V, Z, H, cs, sn, gv, y, rb: b, r, dx, wmask } = work;
  const mRestart = Z.length;
  // Consistent warm start: main component 0, island levels uniform.
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(psi[i])) psi[i] = 0;
    if (!wet[i] && comp[i] === 0) psi[i] = 0;
  }
  for (let k = 0; k < S.nIslands; k++) {
    const val = psi[S.islCells[S.islCellOff[k]]];
    for (let q = S.islCellOff[k]; q < S.islCellOff[k + 1]; q++) psi[S.islCells[q]] = val;
  }
  residualLayoutRhs(S, rhs, b);
  const bNorm = Math.sqrt(dot(b, b)) || 1;
  // Residual norm below which the remaining velocity error is ≲ tolU even for smooth, basin-scale
  // errors (a velocity error δu of scale L cells leaves a residual ≈ r·δu·H·RΔφ/L² per cell).
  let nMask = 0;
  for (let i = 0; i < n; i++) nMask += wmask[i];
  const resTol = Math.max(1e-11 * bNorm, RES_TOL_FACTOR * S.r * tolU * oceanTuning.effectiveDepth * EARTH_RADIUS_M * g.dLat * Math.sqrt(nMask));
  let sweeps = 0;
  let maxDu = Infinity;
  while (sweeps < maxSweeps) {
    applyOperator(S, psi, r);
    for (let i = 0; i < n; i++) r[i] = b[i] - r[i];
    const beta = Math.sqrt(dot(r, r));
    if (!(beta > resTol)) {
      maxDu = 0;
      break;
    }
    const v0 = V[0];
    for (let i = 0; i < n; i++) v0[i] = r[i] / beta;
    gv.fill(0);
    gv[0] = beta;
    let k = 0;
    for (; k < mRestart && sweeps < maxSweeps; k++) {
      precondition(S, V[k], Z[k], work);
      sweeps++;
      const w = V[k + 1];
      applyOperator(S, Z[k], w);
      // Modified Gram–Schmidt.
      for (let q = 0; q <= k; q++) {
        const h = dot(w, V[q]);
        H[q * mRestart + k] = h;
        const vq = V[q];
        for (let i = 0; i < n; i++) w[i] -= h * vq[i];
      }
      const hn = Math.sqrt(dot(w, w));
      if (hn > 0) for (let i = 0; i < n; i++) w[i] /= hn;
      // Apply previous Givens rotations to the new column, then create one for (k, k+1).
      for (let q = 0; q < k; q++) {
        const a = H[q * mRestart + k], c2 = H[(q + 1) * mRestart + k];
        H[q * mRestart + k] = cs[q] * a + sn[q] * c2;
        H[(q + 1) * mRestart + k] = -sn[q] * a + cs[q] * c2;
      }
      const hkk = H[k * mRestart + k];
      const den = Math.hypot(hkk, hn);
      cs[k] = den > 0 ? hkk / den : 1;
      sn[k] = den > 0 ? hn / den : 0;
      H[k * mRestart + k] = den;
      gv[k + 1] = -sn[k] * gv[k];
      gv[k] = cs[k] * gv[k];
      if (Math.abs(gv[k + 1]) < resTol || hn === 0) {
        k++;
        break;
      }
    }
    // Back-substitute the small triangular system and update Ψ.
    for (let q = k - 1; q >= 0; q--) {
      let s = gv[q];
      for (let c = q + 1; c < k; c++) s -= H[q * mRestart + c] * y[c];
      const d = H[q * mRestart + q];
      y[q] = d !== 0 ? s / d : 0;
    }
    dx.fill(0);
    for (let q = 0; q < k; q++) {
      const zq = Z[q];
      const yq = y[q];
      for (let i = 0; i < n; i++) dx[i] += yq * zq[i];
    }
    let maxD = 0;
    for (let j = 0; j < g.ny; j++) {
      const secant = g.cosLat[j] > 0.2 ? 1 / g.cosLat[j] : 5;
      for (let i = j * g.nx; i < (j + 1) * g.nx; i++) {
        psi[i] += dx[i];
        const ad = (dx[i] < 0 ? -dx[i] : dx[i]) * secant;
        if (ad > maxD) maxD = ad;
      }
    }
    maxDu = maxD * uScale;
    if (maxDu < tolU || !Number.isFinite(maxDu)) break;
  }
  return { sweeps, maxDu };
}
