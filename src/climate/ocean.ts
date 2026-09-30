/**
 * Wind-driven ocean (SPEC §6.1.6): wind stress with gustiness, its curl in finite-volume flux form,
 * the Stommel transport streamfunction (oceanStommel.ts), surface currents = geostrophic part from Ψ
 * over a fixed effective depth + Ekman drift, and Ekman upwelling w = ∇·M (M·n = 0 at coasts).
 */
import { OMEGA_EARTH } from '../core/constants';
import { EARTH_RADIUS_M, type LatLonGrid } from './dynGrid';
import { smooth121Masked } from './numerics';
import { makeStommelWork, solveStommel } from './oceanSolver';
import { buildStommelSetup, type StommelSetup } from './oceanStommel';
import { coriolis } from './circulation';
import { oceanTuning, windTuning } from './tuning';

export interface OceanResult {
  /** Surface current, m/s, 12·n (0 on land). */
  currentU: Float64Array;
  currentV: Float64Array;
  /** Ekman upwelling w⁺ ≥ 0, m/s, 12·n (0 on land). */
  upwelling: Float64Array;
  /** Transport streamfunction, m³/s, 12·n. */
  psi: Float64Array;
  /** Stommel solutions per Fourier component of the forcing (warm start for later solves). */
  components: Float64Array;
  stats: Record<string, number>;
}

/**
 * Wind stress τ = ρ_a C_d sqrt(|u|² + σ²) u, N/m². σ² = gustiness² + (stormGustiness·storm)²: the
 * sub-monthly wind variance of the storm tracks (optional normalized storm-track index `storm`,
 * 12·n like U) raises the mean stress of a given monthly-mean wind (⟨|u|u⟩ > |ū|ū).
 */
export function windStress(U: ArrayLike<number>, V: ArrayLike<number>, off: number, n: number, tx: Float64Array, ty: Float64Array, storm?: ArrayLike<number> | null): void {
  const T = oceanTuning;
  const k = windTuning.rhoAir * T.dragCoeff;
  const s2 = T.gustiness * T.gustiness;
  const gs = T.stormGustiness;
  for (let i = 0; i < n; i++) {
    const u = U[off + i], v = V[off + i];
    let g2 = s2;
    if (storm && gs > 0) {
      const b = Math.min(T.stormGustinessMax, Math.max(0, storm[off + i])) * gs;
      g2 += b * b;
    }
    const sp = Math.sqrt(u * u + v * v + g2);
    tx[i] = k * sp * u;
    ty[i] = k * sp * v;
  }
}

/**
 * Cell-integrated curl of τ divided by ρ₀ (m³/s²): R·[dφ(τ_v,e − τ_v,w) − dλ(cosφ_n τ_u,n − cosφ_s τ_u,s)]/ρ₀,
 * face values averaged from the adjacent cells (so sums over regions telescope to boundary circulations).
 * Smoothed as a per-area field before integration.
 */
export function curlRhs(g: LatLonGrid, tx: Float64Array, ty: Float64Array, out: Float64Array): void {
  const T = oceanTuning;
  const { nx, ny } = g;
  const R = EARTH_RADIUS_M;
  const perArea = new Float64Array(g.n);
  for (let j = 0; j < ny; j++) {
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const ie = j * nx + (c === nx - 1 ? 0 : c + 1);
      const iw = j * nx + (c === 0 ? nx - 1 : c - 1);
      const tve = 0.5 * (ty[i] + ty[ie]);
      const tvw = 0.5 * (ty[i] + ty[iw]);
      const tun = j > 0 ? 0.5 * (tx[i] + tx[i - nx]) * g.faceCos[j] : 0;
      const tus = j < ny - 1 ? 0.5 * (tx[i] + tx[i + nx]) * g.faceCos[j + 1] : 0;
      const integrated = (R * (g.dLat * (tve - tvw) - g.dLon * (tun - tus))) / T.rhoWater;
      perArea[i] = integrated / g.area[j];
    }
  }
  smooth121Masked(g, perArea, null, T.curlSmoothPasses);
  for (let j = 0; j < ny; j++) for (let c = 0; c < nx; c++) out[j * nx + c] = perArea[j * nx + c] * g.area[j];
}

/** Regularized Ekman transport M = (r_E τ − f k×τ)/(ρ₀(r_E² + f²)), m²/s. */
export function ekmanTransport(g: LatLonGrid, tx: Float64Array, ty: Float64Array, f: Float64Array, Mx: Float64Array, My: Float64Array): void {
  const T = oceanTuning;
  const rE = 2 * OMEGA_EARTH * Math.sin((T.ekmanRegLat * Math.PI) / 180);
  for (let j = 0; j < g.ny; j++) {
    const fj = f[j];
    const den = T.rhoWater * (rE * rE + fj * fj);
    for (let c = 0; c < g.nx; c++) {
      const i = j * g.nx + c;
      Mx[i] = (rE * tx[i] + fj * ty[i]) / den;
      My[i] = (rE * ty[i] - fj * tx[i]) / den;
    }
  }
}

/** Upwelling w = ∇·M (m/s) in FV form with no flux through faces touching land; returns w⁺. */
export function ekmanUpwelling(g: LatLonGrid, ocean: Uint8Array, Mx: Float64Array, My: Float64Array, out: Float64Array): void {
  const { nx, ny } = g;
  const R = EARTH_RADIUS_M;
  for (let j = 0; j < ny; j++) {
    const aR = R * g.area[j];
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (!ocean[i]) {
        out[i] = 0;
        continue;
      }
      const ie = j * nx + (c === nx - 1 ? 0 : c + 1);
      const iw = j * nx + (c === 0 ? nx - 1 : c - 1);
      const fe = ocean[ie] ? 0.5 * (Mx[i] + Mx[ie]) : 0;
      const fw = ocean[iw] ? 0.5 * (Mx[i] + Mx[iw]) : 0;
      const fn = j > 0 && ocean[i - nx] ? 0.5 * (My[i] + My[i - nx]) * g.faceCos[j] : 0;
      const fs = j < ny - 1 && ocean[i + nx] ? 0.5 * (My[i] + My[i + nx]) * g.faceCos[j + 1] : 0;
      const w = ((fe - fw) * g.dLat + (fn - fs) * g.dLon) / aR;
      out[i] = w > 0 ? w : 0;
    }
  }
}

/**
 * Surface geostrophic current from Ψ over the effective depth (central differences, wall values at
 * dry cells). The zonal part is tapered toward the equator, sin²φ/(sin²φ + sin²φ_t): inside the
 * equatorial waveguide the zonal Sverdrup transport is carried by the thermocline and undercurrent
 * (baroclinic, wave-adjusted), not by a surface jet of the barotropic flow.
 */
function currentsFromPsi(S: StommelSetup, ocean: Uint8Array, psi: Float64Array, off: number, U: Float64Array, V: Float64Array): void {
  const T = oceanTuning;
  const { g, j0, j1 } = S;
  const { nx } = g;
  const R = EARTH_RADIUS_M;
  const H = T.effectiveDepth;
  const st2 = Math.sin((T.equatorTaperLat * Math.PI) / 180) ** 2;
  for (let j = j0; j <= j1; j++) {
    const s2 = g.sinLat[j] * g.sinLat[j];
    const taper = st2 > 0 ? s2 / (s2 + st2) : 1;
    const dy = (2 * R * g.dLat * H) / taper;
    const dx = 2 * R * g.cosLat[j] * g.dLon * H;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (!ocean[i]) continue;
      const ie = j * nx + (c === nx - 1 ? 0 : c + 1);
      const iw = j * nx + (c === 0 ? nx - 1 : c - 1);
      U[off + i] = -(psi[off + i - nx] - psi[off + i + nx]) / dy;
      V[off + i] = (psi[off + ie] - psi[off + iw]) / dx;
    }
  }
}

export interface OceanContext {
  g: LatLonGrid;
  setup: StommelSetup;
  /** 1 = real ocean cell (core land mask = 0). */
  ocean: Uint8Array;
  f: Float64Array;
}

export function makeOceanContext(g: LatLonGrid, landFraction: Float64Array, land: Uint8Array, retrograde: boolean): OceanContext {
  const ocean = new Uint8Array(g.n);
  const solverLand = new Uint8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    ocean[i] = land[i] ? 0 : 1;
    solverLand[i] = land[i] || landFraction[i] >= oceanTuning.solverLandThreshold ? 1 : 0;
  }
  return { g, setup: buildStommelSetup(g, solverLand, retrograde), ocean, f: coriolis(g, retrograde) };
}

/**
 * Monthly currents and upwelling from monthly surface winds (12·n). `warm` (a previous result for
 * the same land mask) warm-starts the Stommel solves.
 */
export function computeOcean(
  ctx: OceanContext,
  windU: Float64Array,
  windV: Float64Array,
  warm: OceanResult | null,
  fast = false,
  storm: Float64Array | null = null,
): OceanResult {
  const T = oceanTuning;
  const { g, setup, ocean, f } = ctx;
  const n = g.n;
  const currentU = new Float64Array(12 * n);
  const currentV = new Float64Array(12 * n);
  const upwelling = new Float64Array(12 * n);
  const psi = new Float64Array(12 * n);
  const tx = new Float64Array(n), ty = new Float64Array(n);
  const rhsM = new Float64Array(12 * n);
  const Mx = new Float64Array(n), My = new Float64Array(n), w = new Float64Array(n);
  const work = makeStommelWork(setup);
  const stats: Record<string, number> = {};

  // Monthly cell-integrated curl of the wind stress.
  for (let m = 0; m < 12; m++) {
    windStress(windU, windV, m * n, n, tx, ty, storm);
    curlRhs(g, tx, ty, rhsM.subarray(m * n, (m + 1) * n));
  }
  // The Stommel operator is linear and the same every month: solve its response to each Fourier
  // component of the monthly forcing (mean, cos/sin of harmonics up to maxHarmonic) and recombine.
  // Components are warm-started from the previous solve (if any).
  const comps = harmonicBasis().filter((c) => c.harmonic <= T.maxHarmonic);
  const rhs = new Float64Array(n);
  const sol = new Float64Array(comps.length * n);
  if (warm && warm.components.length === sol.length) sol.set(warm.components);
  let totalSweeps = 0;
  let worst = 0;
  for (let k = 0; k < comps.length; k++) {
    const basis = comps[k];
    rhs.fill(0);
    for (let m = 0; m < 12; m++) {
      const wgt = basis.analysis[m];
      if (wgt === 0) continue;
      const o = m * n;
      for (let i = 0; i < n; i++) rhs[i] += wgt * rhsM[o + i];
    }
    const x = sol.subarray(k * n, (k + 1) * n);
    const table = fast ? (warm ? T.sweepsWarmFast : T.sweepsColdFast) : warm ? T.sweepsWarm : T.sweepsCold;
    const budget = table[Math.min(2, basis.harmonic)];
    const res = solveStommel(setup, rhs, x, budget, T.tolerance, work);
    totalSweeps += res.sweeps;
    stats[`sweeps.c${k}`] = res.sweeps;
    if (res.maxDu > worst) worst = res.maxDu;
  }
  for (let m = 0; m < 12; m++) {
    const off = m * n;
    for (let k = 0; k < comps.length; k++) {
      const s = comps[k].synthesis[m];
      if (s === 0) continue;
      const ko = k * n;
      for (let i = 0; i < n; i++) psi[off + i] += s * sol[ko + i];
    }
    currentsFromPsi(setup, ocean, psi, off, currentU, currentV);
    // Ekman drift and upwelling.
    windStress(windU, windV, off, n, tx, ty, storm);
    ekmanTransport(g, tx, ty, f, Mx, My);
    ekmanUpwelling(g, ocean, Mx, My, w);
    smooth121Masked(g, w, ocean, T.upwellingSmoothPasses);
    const hE = T.ekmanDepth;
    for (let i = 0; i < n; i++) {
      if (!ocean[i]) {
        currentU[off + i] = 0;
        currentV[off + i] = 0;
        continue;
      }
      let u = currentU[off + i] + Mx[i] / hE;
      let v = currentV[off + i] + My[i] / hE;
      const s = Math.sqrt(u * u + v * v);
      if (s > T.maxCurrent) {
        u *= T.maxCurrent / s;
        v *= T.maxCurrent / s;
      }
      currentU[off + i] = u;
      currentV[off + i] = v;
      upwelling[off + i] = w[i];
    }
  }
  let psiMax = 0;
  for (let i = 0; i < psi.length; i++) psiMax = Math.max(psiMax, Math.abs(psi[i]));
  stats.psiMaxSv = psiMax / 1e6;
  stats.stommelSweeps = totalSweeps;
  stats.stommelResidual = worst;
  stats.islands = setup.nIslands;
  return { currentU, currentV, upwelling, psi, components: sol, stats };
}

interface HarmonicComponent {
  harmonic: number;
  /** Weights turning 12 monthly fields into this component's amplitude. */
  analysis: Float64Array;
  /** Weights turning the component back into each month. */
  synthesis: Float64Array;
}

/** Real discrete Fourier basis over 12 months (exact: 12 components for 12 samples). */
function harmonicBasis(): HarmonicComponent[] {
  const out: HarmonicComponent[] = [];
  const mk = (harmonic: number, fn: (m: number) => number, norm: number): void => {
    const analysis = new Float64Array(12);
    const synthesis = new Float64Array(12);
    for (let m = 0; m < 12; m++) {
      synthesis[m] = fn(m);
      analysis[m] = norm * fn(m);
    }
    out.push({ harmonic, analysis, synthesis });
  };
  mk(0, () => 1, 1 / 12);
  for (let k = 1; k <= 5; k++) {
    mk(k, (m) => Math.cos((2 * Math.PI * k * m) / 12), 2 / 12);
    mk(k, (m) => Math.sin((2 * Math.PI * k * m) / 12), 2 / 12);
  }
  mk(6, (m) => (m % 2 === 0 ? 1 : -1), 1 / 12);
  return out;
}

