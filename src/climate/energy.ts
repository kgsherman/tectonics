/**
 * Coupled seasonal energy-balance model (SPEC §6.1.3): one integrator for land, the ocean mixed
 * layer, sea ice and the air above them on the lat-lon core grid (Budyko–Sellers / North et al.):
 *
 *   land:   C_L dT/dt  = Q(1−α) − (A + B·T_s) + ∇·(D∇T) + air advection + k_ft(h)(T̄_row − T)
 *                                                                      (T_s = T − Γh, sea-level-reduced T)
 *   ocean:  C_o dT_o/dt = Q(1−α) − (A + B·T_o) + γ(T_a − T_o) − λ_u(T_o − T_sub) + ∇·(D_o∇T_o)
 *                         + current advection − k_c·max(0, T_o − T_c)   (convective thermostat)
 *           C_a dT_a/dt = ∇·(D∇T_a) + air advection + γ(T_sfc − T_a)
 *   ice:    C_i dT_i/dt = Q(1−α_i) − (A + B·T_i) + K(T_f − T_i) + γ(T_a − T_i), T_i ≤ 0 (surplus melts)
 *
 * Over the ocean the transported air layer is coupled to the slab ocean through the air–sea
 * exchange coefficient γ, so sea-surface anomalies (upwelling tongues, warm currents) survive the
 * strong atmospheric smoothing. Over land the air column is the land temperature itself; high
 * terrain is also coupled to the jet-mixed free troposphere (k_ft). Snow albedo is lagged one step,
 * ramped on the surface temperature, patchy on high terrain unless the cell is an ice sheet.
 *
 * State per cell:
 *  - T    : air temperature, sea-level reduced over land (the transported field),
 *  - E    : ocean enthalpy J/m² (E ≥ 0: mixed layer T_o = T_f + E/C_o; E < 0: sea ice with fraction
 *           a = min(1, −E/E_full), open water at T_f),
 *  - Ti   : sea-ice surface temperature,
 *  - Tann : running annual-mean surface temperature (ice-sheet vs seasonal-snow memory).
 *
 * This file holds the model setup and state; the time stepping lives in energyStep.ts. Each ~5-day
 * step is operator split, backward Euler throughout: (1) local implicit step for the air/land
 * (sub-stepped with semi-Lagrangian air advection in pass 2), (2) mixed-layer advection by
 * currents, (3) local implicit ocean / sea-ice step, (3b) implicit ocean heat diffusion,
 * (4) implicit periodic tridiagonal diffusion of the air per row, (5) implicit tridiagonal
 * diffusion per column (finite-volume flux form on the unit sphere, per-face coefficients).
 */
import { LAPSE_RATE } from '../core/constants';
import type { ClimateParams } from '../core/types';
import type { SLStencil } from './dynAdvect';
import type { LatLonGrid } from './dynGrid';
import { insolationTable } from './insolation';
import { makeCyclicWork, type CyclicWork } from './numerics';
import { ebmTuning } from './tuning';

export const SECONDS_PER_YEAR = 365.2422 * 86400;

export interface EbmModel {
  g: LatLonGrid;
  land: Uint8Array;
  /** Γ·(surface height above sea level) per land cell (K); 0 over ocean. */
  lapse: Float64Array;
  /**
   * Coupling (W/m²/K) of high-terrain land to the free troposphere: the air over high plateaus and
   * ranges is part of the jet-mixed free atmosphere, so its sea-level-reduced temperature is pulled
   * toward the zonal mean of its latitude.
   */
  freeTrop: Float64Array;
  stepsPerMonth: number;
  stepsPerYear: number;
  /** Step length, s. */
  dt: number;
  /** Daily-mean TOA insolation per step and row (W/m²). */
  insol: Float64Array;
  /** Snow-free planetary albedo per row (land / open water). */
  albLand: Float64Array;
  albWater: Float64Array;
  /** Mixed-layer heat capacity per row, J/m²/K. */
  cOcean: Float64Array;
  /**
   * FV diffusion couplings per cell (W/m²/K per unit area of that cell): across its east face, its
   * north face and its south face. Faces touching land carry the land diffusion factor.
   */
  kE: Float64Array;
  kN: Float64Array;
  kS: Float64Array;
  /** Ocean mixed-layer diffusion couplings (same layout; zero across faces touching land). */
  oE: Float64Array;
  oN: Float64Array;
  oS: Float64Array;
  /** Sea-ice enthalpy at full cover and at the thickness cap, J/m² (positive numbers). */
  eFull: number;
  eMax: number;
  work: EbmWork;
}

export interface EbmState {
  T: Float64Array;
  E: Float64Array;
  Ti: Float64Array;
  /** Running annual mean of the surface temperature (1-year e-folding), °C: tells ice sheets from seasonal snow. */
  Tann: Float64Array;
}

/** Pass-2 couplings. Stencils are per month; velocities are already scaled. */
export interface EbmCoupling {
  air: SLStencil[] | null;
  /**
   * Per month (12·n): coupling factors of advected air over land for warm and cold advection.
   * Warm advection over colder land is stable (surface inversion) and couples weakly; shallow cold
   * air cannot climb onto higher terrain; warm air descending from higher terrain overrides (does
   * not mix into) a cold lowland air mass (cold-air damming, lee shelter).
   */
  airWarm: Float32Array | null;
  airCold: Float32Array | null;
  /** Per month (12·n): planetary-albedo offset over land from cloudiness (clear skies under subsidence). */
  landAlbedoOffset: Float64Array | null;
  sea: SLStencil[] | null;
  /** Nearest ocean cell per cell (extends SST under land before advection). */
  nearestOcean: Int32Array | null;
  /** Upwelling damping λ_u = ρc·w⁺·efficiency, W/m²/K, 12·n. */
  upwellLambda: Float64Array | null;
  /** Temperature of upwelled water per cell, °C. */
  tSub: Float64Array | null;
}

export const NO_COUPLING: EbmCoupling = { air: null, airWarm: null, airCold: null, landAlbedoOffset: null, sea: null, nearestOcean: null, upwellLambda: null, tSub: null };

/** Monthly means (12·n each): air temperature (sea-level reduced over land), SST, sea-ice fraction. */
export interface EbmMonthly {
  tAir: Float64Array;
  sst: Float64Array;
  ice: Float64Array;
}

/** Scratch buffers of the integrator (energyStep.ts). */
export interface EbmWork {
  F: Float64Array;
  dep: Float64Array;
  To: Float64Array;
  tAirMean: Float64Array;
  cEff: Float64Array;
  ice: Float64Array;
  ra: Float64Array;
  rb: Float64Array;
  rc: Float64Array;
  rd: Float64Array;
  rx: Float64Array;
  ca: Float64Array;
  cb: Float64Array;
  cc: Float64Array;
  cd: Float64Array;
  cx: Float64Array;
  cp: Float64Array;
  cyc: CyclicWork;
}

/** Diffusivity D(φ) on the unit sphere (W/m²/K). */
export function diffusivity(sinPhi: number): number {
  const s2 = sinPhi * sinPhi;
  const t = ebmTuning;
  return t.diffusion * Math.max(0.05, 1 + t.diffusionD2 * s2 + t.diffusionD4 * s2 * s2);
}

export function makeEbmModel(g: LatLonGrid, land: Uint8Array, height: Float64Array, params: ClimateParams, stepsPerMonth: number): EbmModel {
  const t = ebmTuning;
  const { nx, ny, n } = g;
  const stepsPerYear = 12 * stepsPerMonth;
  const lapse = new Float64Array(n);
  const freeTrop = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lapse[i] = land[i] ? LAPSE_RATE * Math.max(0, height[i]) : 0;
    const x = land[i] ? Math.max(0, height[i]) / t.freeTropHeight : 0;
    freeTrop[i] = t.freeTropCoupling * Math.min(1, x * x);
  }
  const albLand = new Float64Array(ny);
  const albWater = new Float64Array(ny);
  const cOcean = new Float64Array(ny);
  const kE = new Float64Array(n);
  const kN = new Float64Array(n);
  const kS = new Float64Array(n);
  // Face factor: mean of the two cells' factors (1 over ocean, landDiffusionFactor over land,
  // iceSheetDiffusionFactor over high polar plateaus whose surface inversions decouple them).
  const polarSin = Math.sin((t.iceSheetLat * Math.PI) / 180);
  const fc = (i: number): number => {
    if (!land[i]) return 1;
    const polarPlateau = Math.abs(g.sinLat[(i / nx) | 0]) > polarSin && height[i] > t.iceSheetHeight;
    return polarPlateau ? t.iceSheetDiffusionFactor : t.landDiffusionFactor;
  };
  for (let j = 0; j < ny; j++) {
    const s = g.sinLat[j];
    const p2 = 0.5 * (3 * s * s - 1);
    albLand[j] = t.albedoBase + t.albedoP2 * p2;
    albWater[j] = albLand[j] + t.albedoOceanOffset;
    cOcean[j] = t.rhoCpWater * (t.mixedLayerMin + (t.mixedLayerMax - t.mixedLayerMin) * s * s);
    // Zonal faces: length dφ, center distance cosφ·dλ; per unit cell area.
    const kx = (diffusivity(s) * g.dLat) / (g.cosLat[j] * g.dLon * g.area[j]);
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const e = j * nx + (c === nx - 1 ? 0 : c + 1);
      kE[i] = kx * 0.5 * (fc(i) + fc(e));
    }
  }
  for (let j = 0; j + 1 < ny; j++) {
    // Face between rows j and j+1 at faceSin[j+1]: length dλ·cosφ_f, center distance dφ.
    const flux = (diffusivity(g.faceSin[j + 1]) * g.dLon * g.faceCos[j + 1]) / g.dLat;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const f = flux * 0.5 * (fc(i) + fc(i + nx));
      kS[i] = f / g.area[j];
      kN[i + nx] = f / g.area[j + 1];
    }
  }
  // Ocean heat diffusion (eddies/overturning) between ocean cells only.
  const oE = new Float64Array(n);
  const oN = new Float64Array(n);
  const oS = new Float64Array(n);
  const Do = t.oceanDiffusion;
  for (let j = 0; j < ny; j++) {
    const kx = (Do * g.dLat) / (g.cosLat[j] * g.dLon * g.area[j]);
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const e = j * nx + (c === nx - 1 ? 0 : c + 1);
      if (!land[i] && !land[e]) oE[i] = kx;
    }
  }
  for (let j = 0; j + 1 < ny; j++) {
    const flux = (Do * g.dLon * g.faceCos[j + 1]) / g.dLat;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (land[i] || land[i + nx]) continue;
      oS[i] = flux / g.area[j];
      oN[i + nx] = flux / g.area[j + 1];
    }
  }
  const eFull = t.iceLatent * t.iceFullThickness;
  const eMax = t.iceLatent * t.iceMaxThickness;
  const m = Math.max(nx, ny);
  const work: EbmWork = {
    F: new Float64Array(n), dep: new Float64Array(n), To: new Float64Array(n), tAirMean: new Float64Array(n),
    cEff: new Float64Array(n), ice: new Float64Array(n),
    ra: new Float64Array(m), rb: new Float64Array(m), rc: new Float64Array(m), rd: new Float64Array(m), rx: new Float64Array(m),
    ca: new Float64Array(m), cb: new Float64Array(m), cc: new Float64Array(m), cd: new Float64Array(m), cx: new Float64Array(m),
    cp: new Float64Array(m), cyc: makeCyclicWork(nx),
  };
  return {
    g, land, lapse, freeTrop, stepsPerMonth, stepsPerYear, dt: SECONDS_PER_YEAR / stepsPerYear,
    insol: insolationTable(g, stepsPerYear, params.axialTilt, params.solarMultiplier),
    albLand, albWater, cOcean, kE, kN, kS, oE, oN, oS, eFull, eMax, work,
  };
}

export function makeState(n: number): EbmState {
  return { T: new Float64Array(n), E: new Float64Array(n), Ti: new Float64Array(n), Tann: new Float64Array(n) };
}

export function cloneState(s: EbmState): EbmState {
  return { T: s.T.slice(), E: s.E.slice(), Ti: s.Ti.slice(), Tann: s.Tann.slice() };
}

export function makeMonthly(n: number): EbmMonthly {
  return { tAir: new Float64Array(12 * n), sst: new Float64Array(12 * n), ice: new Float64Array(12 * n) };
}

/** Snow/ice albedo ramp weight (0 = snow-free, 1 = full snow) on surface temperature. */
export function snowWeight(ts: number): number {
  const t = ebmTuning;
  const r = (t.snowRampWarm - ts) / (t.snowRampWarm - t.snowRampCold);
  return r <= 0 ? 0 : r >= 1 ? 1 : r;
}

/**
 * Fraction of the snow albedo effect realized on land: seasonal snow on high terrain is patchy
 * (wind-scoured, sublimating, rock and forest exposed) unless the surface is frozen year-round
 * (ice sheets: annual-mean surface temperature well below 0 °C). Γh = lapse (K) of the cell.
 */
export function snowCoverFactor(tAnnualSurface: number, lapseK: number): number {
  const t = ebmTuning;
  const x = lapseK / (LAPSE_RATE * t.snowPatchyHeight);
  return Math.max(iceSheetWeight(tAnnualSurface), 1 / (1 + x * x));
}

/** 0..1: how much a land cell with this annual-mean surface temperature behaves as an ice sheet. */
export function iceSheetWeight(tAnnualSurface: number): number {
  return Math.min(1, Math.max(0, (ebmTuning.snowPolarWarm - tAnnualSurface) / 10));
}

/** Sea-ice fraction for an ocean enthalpy. */
export function iceFraction(E: number, eFull: number): number {
  return E >= 0 ? 0 : Math.min(1, -E / eFull);
}

/** Set the ocean cells' air temperature to their surface temperature (initialization). */
export function syncOceanAirT(M: EbmModel, S: EbmState): void {
  const { g, land, cOcean, eFull } = M;
  const Tf = ebmTuning.freezeT;
  for (let j = 0; j < g.ny; j++) {
    const Co = cOcean[j];
    for (let c = 0; c < g.nx; c++) {
      const i = j * g.nx + c;
      if (land[i]) continue;
      const E = S.E[i];
      const a = iceFraction(E, eFull);
      S.T[i] = (1 - a) * (Tf + Math.max(0, E) / Co) + a * S.Ti[i];
    }
  }
}

/**
 * Aitken Δ² extrapolation of the slow ocean enthalpy from three start-of-year states
 * (s0 → s1 → s2); s2 is updated in place. Cells whose drift is not a contraction are left alone.
 */
export function aitkenExtrapolate(M: EbmModel, s0: EbmState, s1: EbmState, s2: EbmState): number {
  const t = ebmTuning;
  const { g, land, cOcean } = M;
  let changed = 0;
  for (let j = 0; j < g.ny; j++) {
    const Co = cOcean[j];
    const maxJump = t.aitkenMaxJump * Co;
    for (let c = 0; c < g.nx; c++) {
      const i = j * g.nx + c;
      if (land[i]) continue;
      const d1 = s1.E[i] - s0.E[i];
      const d2 = s2.E[i] - s1.E[i];
      if (Math.abs(d1) < 0.02 * Co) continue;
      const q = d2 / d1;
      if (!(q > 0 && q < t.aitkenMaxRatio)) continue;
      let jump = (d2 * q) / (1 - q);
      if (jump > maxJump) jump = maxJump;
      else if (jump < -maxJump) jump = -maxJump;
      let e = s2.E[i] + jump;
      if (e < -M.eMax) e = -M.eMax;
      // Do not jump across the freezing point: let the model make that transition.
      if ((e < 0) !== (s2.E[i] < 0)) e = 0;
      s2.E[i] = e;
      changed++;
    }
  }
  return changed;
}
