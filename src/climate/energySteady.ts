/**
 * Spin-up helpers for the energy balance (SPEC §6.1.3):
 *  1. implicit annual-mean steady solve  B·T − ∇·(D∇T) = Q̄(1−α(T)) − A + B·Γh
 *     (preconditioned conjugate gradients with row-line preconditioner, albedo fixed-point), then
 *  2. analytic periodic local solution: T(t) = T̄ + Re Σ_h F̂_h e^{ihωt} / (λ + ihωC) for the annual
 *     and semi-annual harmonics of the absorbed insolation, used as the Jan 1 initial state.
 */
import { SECONDS_PER_YEAR, iceSheetWeight, snowCoverFactor, snowfallRate, snowWeight, syncOceanAirT, type EbmModel, type EbmState } from './energy';
import { makeCyclicWork, nearestValidIndex, solveCyclic } from './numerics';
import { ebmTuning, spinupTuning } from './tuning';

/** Annual-mean insolation per row. */
function annualInsolation(M: EbmModel): Float64Array {
  const { ny } = M.g;
  const q = new Float64Array(ny);
  for (let k = 0; k < M.stepsPerYear; k++) for (let j = 0; j < ny; j++) q[j] += M.insol[k * ny + j];
  for (let j = 0; j < ny; j++) q[j] /= M.stepsPerYear;
  return q;
}

/** Planetary albedo of a cell for a (steady or seasonal) surface temperature. */
function cellAlbedo(M: EbmModel, i: number, j: number, t: number): number {
  const aI = ebmTuning.albedoIce;
  if (M.land[i]) {
    const a0 = M.albLand[j];
    const ts = t - M.lapse[i];
    return a0 + (aI - a0) * snowWeight(ts) * snowCoverFactor(iceSheetWeight(ts), M.lapse[i]);
  }
  const a0 = M.albWater[j];
  return a0 + (aI - a0) * snowWeight(t);
}

/** y = A·x with A the area-weighted (symmetric) steady operator. */
function applyOperator(M: EbmModel, x: Float64Array, y: Float64Array): void {
  const { g, kE, kN, kS } = M;
  const { nx, ny } = g;
  const B = ebmTuning.olrB;
  for (let j = 0; j < ny; j++) {
    const ar = g.area[j];
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const iw = c === 0 ? i + nx - 1 : i - 1;
      const ie = c === nx - 1 ? i - nx + 1 : i + 1;
      const xi = x[i];
      let v = B * xi + kE[iw] * (xi - x[iw]) + kE[i] * (xi - x[ie]);
      if (j > 0) v += kN[i] * (xi - x[i - nx]);
      if (j < ny - 1) v += kS[i] * (xi - x[i + nx]);
      y[i] = ar * v;
    }
  }
}

/**
 * Solve the annual-mean steady state. Returns the sea-level-reduced steady temperature per cell.
 */
export function steadyAnnualMean(M: EbmModel): Float64Array {
  const t = ebmTuning;
  const { g, land, lapse, kE, kN, kS } = M;
  const { nx, ny, n } = g;
  const B = t.olrB;
  const qBar = annualInsolation(M);
  const T = new Float64Array(n);
  for (let j = 0; j < ny; j++) {
    const s = g.sinLat[j];
    for (let c = 0; c < nx; c++) T[j * nx + c] = 28 - 42 * s * s;
  }
  const rhs = new Float64Array(n);
  const r = new Float64Array(n);
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const q = new Float64Array(n);
  const alb = new Float64Array(n);
  const cyc = makeCyclicWork(nx);
  const ra = new Float64Array(nx), rb = new Float64Array(nx), rc = new Float64Array(nx), rd = new Float64Array(nx), rx = new Float64Array(nx);

  // Block-Jacobi (row) preconditioner: z = P⁻¹ r.
  const precond = (src: Float64Array, dst: Float64Array): void => {
    for (let j = 0; j < ny; j++) {
      const ar = g.area[j];
      for (let c = 0; c < nx; c++) {
        const i = j * nx + c;
        const kw = kE[c === 0 ? i + nx - 1 : i - 1];
        ra[c] = -ar * kw;
        rc[c] = -ar * kE[i];
        rb[c] = ar * (B + kw + kE[i] + (j > 0 ? kN[i] : 0) + (j < ny - 1 ? kS[i] : 0));
        rd[c] = src[i];
      }
      solveCyclic(ra, rb, rc, rd, rx, nx, cyc);
      for (let c = 0; c < nx; c++) dst[j * nx + c] = rx[c];
    }
  };
  const dot = (a: Float64Array, b: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  };

  for (let it = 0; it < spinupTuning.steadyAlbedoIters; it++) {
    for (let j = 0; j < ny; j++) {
      for (let c = 0; c < nx; c++) {
        const i = j * nx + c;
        const a = cellAlbedo(M, i, j, T[i]);
        alb[i] = it === 0 ? a : 0.5 * alb[i] + 0.5 * a;
        rhs[i] = g.area[j] * (qBar[j] * (1 - alb[i]) - t.olrA + (land[i] ? B * lapse[i] : 0));
      }
    }
    // PCG from the current T.
    applyOperator(M, T, q);
    for (let i = 0; i < n; i++) r[i] = rhs[i] - q[i];
    precond(r, z);
    p.set(z);
    let rz = dot(r, z);
    const tol2 = spinupTuning.steadyCgTol * spinupTuning.steadyCgTol * dot(z, z) + 1e-30;
    const tolAbs = spinupTuning.steadyCgTol;
    for (let k = 0; k < spinupTuning.steadyCgMaxIter; k++) {
      applyOperator(M, p, q);
      const pq = dot(p, q);
      if (!(pq > 0)) break;
      const alpha = rz / pq;
      let maxStep = 0;
      for (let i = 0; i < n; i++) {
        const d = alpha * p[i];
        T[i] += d;
        r[i] -= alpha * q[i];
        const ad = d < 0 ? -d : d;
        if (ad > maxStep) maxStep = ad;
      }
      if (maxStep < tolAbs && k > 2) break;
      precond(r, z);
      const rzNew = dot(r, z);
      if (rzNew < tol2 * 1e-12) break;
      const beta = rzNew / rz;
      rz = rzNew;
      for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
  }
  return T;
}

/**
 * Initialize `S` at Jan 1 from the periodic solution of the local linear model around T̄.
 */
export function periodicInit(M: EbmModel, Tbar: Float64Array, S: EbmState): void {
  const t = ebmTuning;
  const { g, land, cOcean, eFull } = M;
  const { nx, ny } = g;
  const N = M.stepsPerYear;
  const lambda = t.olrB + spinupTuning.periodicExtraDamping;
  const omega = (2 * Math.PI) / (N * M.dt);
  // Harmonics of the insolation per row: Q ≈ Q̄ + Σ_h a_h cos(hωt) + b_h sin(hωt).
  const H = 2;
  const ah = new Float64Array(H * ny);
  const bh = new Float64Array(H * ny);
  for (let k = 0; k < N; k++) {
    const ph = (2 * Math.PI * (k + 0.5)) / N;
    for (let h = 1; h <= H; h++) {
      const cs = Math.cos(h * ph), sn = Math.sin(h * ph);
      for (let j = 0; j < ny; j++) {
        const Q = M.insol[k * ny + j];
        ah[(h - 1) * ny + j] += (2 / N) * Q * cs;
        bh[(h - 1) * ny + j] += (2 / N) * Q * sn;
      }
    }
  }
  const Tf = t.freezeT;
  // Land that starts glaciated starts with its ice-sheet albedo and a surface no warmer than the
  // melting point, so the first model year does not melt it with a bare-land summer.
  initialGlaciers(M, Tbar, S);
  for (let j = 0; j < ny; j++) {
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const tb = Tbar[i];
      const sheet = land[i] === 1 && S.M[i] > 0;
      const alb = sheet ? Math.max(cellAlbedo(M, i, j, tb), t.albedoIceSheet) : cellAlbedo(M, i, j, tb);
      const C = land[i] ? t.cLand : cOcean[j];
      // Forcing (1−α)(a cos + b sin) = Re(F̂ e^{iωt}) with F̂ = (1−α)(a − i b); response F̂/(λ + ihωC) at t = 0.
      let dT = 0;
      for (let h = 1; h <= H; h++) {
        const fr = (1 - alb) * ah[(h - 1) * ny + j];
        const fi = -(1 - alb) * bh[(h - 1) * ny + j];
        const dr = lambda;
        const di = h * omega * C;
        const den = dr * dr + di * di;
        dT += (fr * dr + fi * di) / den;
      }
      const T0 = tb + dT;
      S.Tann[i] = land[i] ? tb - M.lapse[i] : tb;
      if (land[i]) {
        S.T[i] = sheet ? Math.min(T0, M.lapse[i]) : T0;
        S.E[i] = 0;
        S.Ti[i] = 0;
      } else if (T0 > Tf) {
        S.E[i] = cOcean[j] * (T0 - Tf);
        S.Ti[i] = Tf;
        S.Ai[i] = 0;
      } else {
        // Ice: thicker for colder mean states, capped.
        S.E[i] = -eFull * Math.min(4, 1 + (Tf - tb) / 10);
        S.Ti[i] = Math.min(Tf, T0);
        S.Ai[i] = 1;
      }
    }
  }
  syncOceanAirT(M, S);
}

/**
 * Cold start of the land ice: a connected region of cold land (steady annual-mean surface
 * temperature below glacierInitT) starts glaciated when it has room for an ice-sheet dome (some of
 * it lies glacierInitCoastKm or more from the ocean) — the ice-covered branch of the hysteresis,
 * which a sheet sustains through its own cold summers — out to glacierInitReachKm from that
 * interior. Cold islands, archipelagos and coastal strips beyond the reach of a dome start bare:
 * their ice caps must grow from snow that survives the summer. The mass balance then keeps,
 * spreads or removes the ice (energyIce.ts).
 */
function initialGlaciers(M: EbmModel, Tbar: Float64Array, S: EbmState): void {
  const t = ebmTuning;
  const { g, land, lapse, coastKm } = M;
  const { nx, ny, n } = g;
  S.M.fill(0);
  S.Ms.fill(0);
  const cold = new Uint8Array(n);
  for (let i = 0; i < n; i++) cold[i] = land[i] && Tbar[i] - lapse[i] < t.glacierInitT ? 1 : 0;
  const seen = new Uint8Array(n);
  const inSheet = new Uint8Array(n);
  const queue = new Int32Array(n);
  for (let s0 = 0; s0 < n; s0++) {
    if (!cold[s0] || seen[s0]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s0;
    seen[s0] = 1;
    let dome = false;
    while (head < tail) {
      const i = queue[head++];
      if (coastKm[i] >= t.glacierInitCoastKm) dome = true;
      const j = (i / nx) | 0;
      const c = i - j * nx;
      const nb = [j * nx + (c === 0 ? nx - 1 : c - 1), j * nx + (c === nx - 1 ? 0 : c + 1), j > 0 ? i - nx : -1, j < ny - 1 ? i + nx : -1];
      for (const k of nb) {
        if (k >= 0 && cold[k] && !seen[k]) {
          seen[k] = 1;
          queue[tail++] = k;
        }
      }
    }
    if (!dome) continue;
    for (let q = 0; q < tail; q++) inSheet[queue[q]] = 1;
  }
  // The dome reaches its margin within glacierInitReachKm of its interior (a plastic ice sheet's
  // profile): a cold archipelago next to a sheet is not buried by it.
  const dome = new Uint8Array(n);
  for (let i = 0; i < n; i++) dome[i] = inSheet[i] && coastKm[i] >= t.glacierInitCoastKm ? 1 : 0;
  const near = nearestValidIndex(nx, ny, dome);
  const R = 6371;
  for (let i = 0; i < n; i++) {
    if (!inSheet[i]) continue;
    const k = near[i];
    if (k < 0) continue;
    const j = (i / nx) | 0;
    const j2 = (k / nx) | 0;
    const cosD = g.sinLat[j] * g.sinLat[j2] + g.cosLat[j] * g.cosLat[j2] * Math.cos(g.lon[i - j * nx] - g.lon[k - j2 * nx]);
    if (R * Math.acos(Math.max(-1, Math.min(1, cosD))) <= t.glacierInitReachKm) {
      S.M[i] = t.glacierMassMax;
      // Its surface carries a year's snowfall (the sheet starts as accumulation zone).
      S.Ms[i] = Math.min(t.glacierMassMax, snowfallRate(Tbar[i] - lapse[i]) * SECONDS_PER_YEAR);
    }
  }
}
