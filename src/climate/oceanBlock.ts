/**
 * Coarse "additive correction" for the Stommel line relaxation: after each sweep, every wet row j
 * is shifted by a uniform δ_j and every island super-node k by δ_k so that the row-summed and
 * island-summed residuals vanish. The unknowns form a bordered tridiagonal system
 *
 *   [T C] [δ_rows]   [res_rows]
 *   [D E] [δ_isl ] = [res_isl ]
 *
 * (T tridiagonal over rows, E diagonal), solved with a Schur complement whose dense island
 * matrix is LU-factored once per land mask. This removes the slow smooth modes (zonal channels,
 * island levels) that line relaxation alone converges slowly.
 */
import { solveTridiag } from './numerics';
import type { StommelSetup } from './oceanStommel';

export interface BlockCorrection {
  m: number;
  nI: number;
  lo: Float64Array;
  diag: Float64Array;
  up: Float64Array;
  /** Row ↔ island couplings as sparse triplets. */
  cRow: Int32Array;
  cIsl: Int32Array;
  cVal: Float64Array;
  dIsl: Int32Array;
  dRow: Int32Array;
  dVal: Float64Array;
  eDiag: Float64Array;
  /** Z = T⁻¹C (m × nI, column-major) and LU of the Schur complement E − D·Z (nI × nI, row-major). */
  Z: Float64Array;
  lu: Float64Array;
  piv: Int32Array;
  work: { a: Float64Array; b: Float64Array; c: Float64Array; d: Float64Array; x: Float64Array; cp: Float64Array; ri: Float64Array; di: Float64Array };
}

export function buildBlockCorrection(S: StommelSetup): BlockCorrection {
  const { g, j0, j1, wet, comp, r, ax, an, as, bw, nIslands: nI } = S;
  const { nx } = g;
  const m = j1 - j0 + 1;
  const lo = new Float64Array(m), diag = new Float64Array(m), up = new Float64Array(m);
  const cMap = new Map<number, number>();
  const dMap = new Map<number, number>();
  const addC = (row: number, isl: number, v: number): void => {
    const key = row * (nI + 1) + isl;
    cMap.set(key, (cMap.get(key) ?? 0) + v);
  };
  const addD = (isl: number, row: number, v: number): void => {
    const key = isl * (m + 1) + row;
    dMap.set(key, (dMap.get(key) ?? 0) + v);
  };
  const eDiag = new Float64Array(nI);
  for (let j = j0; j <= j1; j++) {
    const k = j - j0;
    let dsum = 0;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (!wet[i]) continue;
      const iw = j * nx + (c === 0 ? nx - 1 : c - 1);
      const ie = j * nx + (c === nx - 1 ? 0 : c + 1);
      const inb = i - nx;
      const isb = i + nx;
      dsum -= r * (an[j] + as[j]);
      if (wet[inb]) lo[k] += r * an[j];
      if (wet[isb]) up[k] += r * as[j];
      if (!wet[iw]) dsum -= r * ax[j];
      if (!wet[ie]) dsum -= r * ax[j];
      // Couplings to island levels (the change of this cell's equation when the island shifts).
      if (!wet[iw] && comp[iw] > 0) addC(k, comp[iw] - 1, r * ax[j] - 2 * bw[j]);
      if (!wet[ie] && comp[ie] > 0) addC(k, comp[ie] - 1, r * ax[j] + 2 * bw[j]);
      if (!wet[inb] && comp[inb] > 0) addC(k, comp[inb] - 1, r * an[j]);
      if (!wet[isb] && comp[isb] > 0) addC(k, comp[isb] - 1, r * as[j]);
    }
    diag[k] = dsum !== 0 ? dsum : 1;
  }
  for (let q = 0; q < nI; q++) {
    let sa = 0;
    for (let f = S.islFaceOff[q]; f < S.islFaceOff[q + 1]; f++) {
      const cell = S.islFaceCell[f];
      const row = ((cell / nx) | 0) - j0;
      addD(q, row, r * S.islFaceCoef[f]);
      sa += S.islFaceCoef[f];
    }
    eDiag[q] = sa > 0 ? -r * sa : 1;
  }
  const cRow: number[] = [], cIsl: number[] = [], cVal: number[] = [];
  for (const [key, v] of cMap) {
    cRow.push(Math.floor(key / (nI + 1)));
    cIsl.push(key % (nI + 1));
    cVal.push(v);
  }
  const dIsl: number[] = [], dRow: number[] = [], dVal: number[] = [];
  for (const [key, v] of dMap) {
    dIsl.push(Math.floor(key / (m + 1)));
    dRow.push(key % (m + 1));
    dVal.push(v);
  }
  const work = {
    a: new Float64Array(m), b: new Float64Array(m), c: new Float64Array(m), d: new Float64Array(m),
    x: new Float64Array(m), cp: new Float64Array(m), ri: new Float64Array(nI), di: new Float64Array(nI),
  };
  // Z = T⁻¹ C, one tridiagonal solve per island column.
  const Z = new Float64Array(m * nI);
  const col = new Float64Array(m);
  const zc = new Float64Array(m);
  for (let q = 0; q < nI; q++) {
    col.fill(0);
    for (let t = 0; t < cIsl.length; t++) if (cIsl[t] === q) col[cRow[t]] += cVal[t];
    solveTridiag(lo, diag, up, col, zc, m, work.cp);
    Z.set(zc, q * m);
  }
  // Schur complement Σ = E − D·Z, LU with partial pivoting.
  const lu = new Float64Array(nI * nI);
  for (let q = 0; q < nI; q++) lu[q * nI + q] = eDiag[q];
  for (let t = 0; t < dIsl.length; t++) {
    const q = dIsl[t];
    const row = dRow[t];
    const v = dVal[t];
    for (let p = 0; p < nI; p++) lu[q * nI + p] -= v * Z[p * m + row];
  }
  const piv = new Int32Array(nI);
  luFactor(lu, piv, nI);
  return {
    m, nI, lo, diag, up,
    cRow: Int32Array.from(cRow), cIsl: Int32Array.from(cIsl), cVal: Float64Array.from(cVal),
    dIsl: Int32Array.from(dIsl), dRow: Int32Array.from(dRow), dVal: Float64Array.from(dVal),
    eDiag, Z, lu, piv, work,
  };
}

function luFactor(a: Float64Array, piv: Int32Array, n: number): void {
  for (let k = 0; k < n; k++) {
    let p = k;
    let best = Math.abs(a[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i * n + k]);
      if (v > best) {
        best = v;
        p = i;
      }
    }
    piv[k] = p;
    if (p !== k) {
      for (let c = 0; c < n; c++) {
        const t = a[k * n + c];
        a[k * n + c] = a[p * n + c];
        a[p * n + c] = t;
      }
    }
    const d = a[k * n + k];
    if (d === 0) continue;
    for (let i = k + 1; i < n; i++) {
      const f = (a[i * n + k] /= d);
      if (f === 0) continue;
      for (let c = k + 1; c < n; c++) a[i * n + c] -= f * a[k * n + c];
    }
  }
}

function luSolve(a: Float64Array, piv: Int32Array, n: number, b: Float64Array): void {
  for (let k = 0; k < n; k++) {
    const p = piv[k];
    if (p !== k) {
      const t = b[k];
      b[k] = b[p];
      b[p] = t;
    }
  }
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let c = 0; c < i; c++) s -= a[i * n + c] * b[c];
    b[i] = s;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= a[i * n + c] * b[c];
    const d = a[i * n + i];
    b[i] = d !== 0 ? s / d : 0;
  }
}

/**
 * Compute the residual sums of the current Ψ and apply the block correction. Returns the max
 * |ΔΨ| (scaled by 1/cosφ for velocity) that was applied.
 */
export function applyBlockCorrection(S: StommelSetup, B: BlockCorrection, rhs: Float64Array, islRhs: Float64Array, psi: Float64Array): number {
  const { g, j0, j1, wet, r, ax, an, as, bw } = S;
  const { nx } = g;
  const { m, nI, work } = B;
  const { d, x, cp, ri, di } = work;
  for (let j = j0; j <= j1; j++) {
    let res = 0;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (!wet[i]) continue;
      const iw = j * nx + (c === 0 ? nx - 1 : c - 1);
      const ie = j * nx + (c === nx - 1 ? 0 : c + 1);
      const p = psi[i];
      const pe = psi[ie], pw = psi[iw];
      const fe = wet[ie] ? 0.5 * (p + pe) : pe;
      const fw = wet[iw] ? 0.5 * (p + pw) : pw;
      const Ap = r * (ax[j] * (pe + pw - 2 * p) + an[j] * (psi[i - nx] - p) + as[j] * (psi[i + nx] - p)) + 2 * bw[j] * (fe - fw);
      res += rhs[i] - Ap;
    }
    d[j - j0] = res;
  }
  for (let q = 0; q < nI; q++) {
    let sa = 0;
    let sp = 0;
    const pk = psi[S.islCells[S.islCellOff[q]]];
    for (let f = S.islFaceOff[q]; f < S.islFaceOff[q + 1]; f++) {
      sa += S.islFaceCoef[f];
      sp += S.islFaceCoef[f] * psi[S.islFaceCell[f]];
    }
    ri[q] = islRhs[q] - r * (sp - sa * pk);
  }
  // y = T⁻¹ res_rows; Σ δ_isl = res_isl − D y; δ_rows = y − Z δ_isl.
  solveTridiag(B.lo, B.diag, B.up, d, x, m, cp);
  di.set(ri);
  for (let t = 0; t < B.dIsl.length; t++) di[B.dIsl[t]] -= B.dVal[t] * x[B.dRow[t]];
  if (nI > 0) luSolve(B.lu, B.piv, nI, di);
  for (let q = 0; q < nI; q++) {
    const dq = di[q];
    if (dq === 0) continue;
    for (let k = 0; k < m; k++) x[k] -= B.Z[q * m + k] * dq;
  }
  let maxD = 0;
  for (let j = j0; j <= j1; j++) {
    const dj = x[j - j0];
    if (!Number.isFinite(dj) || dj === 0) continue;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (wet[i]) psi[i] += dj;
    }
    const ad = Math.abs(dj) * (g.cosLat[j] > 0.2 ? 1 / g.cosLat[j] : 5);
    if (ad > maxD) maxD = ad;
  }
  for (let q = 0; q < nI; q++) {
    const dq = di[q];
    if (!Number.isFinite(dq) || dq === 0) continue;
    for (let t = S.islCellOff[q]; t < S.islCellOff[q + 1]; t++) psi[S.islCells[t]] += dq;
    if (Math.abs(dq) > maxD) maxD = Math.abs(dq);
  }
  return maxD;
}
