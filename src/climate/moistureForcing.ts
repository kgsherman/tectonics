/**
 * Forcing fields of the moisture solver (SPEC §6.2), derived from the dynamics result:
 *  - static: smoothed-orography gradient, normalization scales of `ascent` / `baroclinic`, land
 *    fraction, day length;
 *  - per month: saturation column water, the precipitation multiplier M (ascent, subsidence,
 *    baroclinic, orographic lift with lee suppression, cold-SST stability), bulk ocean-evaporation
 *    coefficients, land PET, eddy diffusivity and the flux-form compression factor exp(−dt ∇·u).
 */
import { DEG, LAPSE_RATE } from '../core/constants';
import type { DynamicsResult } from './internal';
import type { HydroTuning } from './hydroTuning';
import { blurSphere, divergence, gradient } from './moistureGrid';
import type { HydroGrid } from './moistureGrid';
import { allocStencil, applyStencil, buildDepartureStencil } from './moistureStencil';
import type { Stencil } from './moistureStencil';
import { substepsFor } from './moistureColumn';
import { hamonPet, iceToWaterSaturation, monthDayLength, satSpecificHumidity, saturationColumnWater } from './moistureThermo';

export interface StaticForcing {
  /** Smoothed height above sea level h⁺ (m). */
  hSmooth: Float64Array;
  /** Gradient (m/m) of the smoothed height above sea level h⁺, eastward / northward. */
  hGradX: Float64Array;
  hGradY: Float64Array;
  /** Divisors normalizing `ascent` and `baroclinic` (Infinity when the field is identically 0). */
  ascentScale: number;
  baroclinicScale: number;
  /** Land fraction per cell, 0..1. */
  landFrac: Float64Array;
  /** 12*h month-mean day length (hours). */
  dayLength: Float64Array;
}

export interface MonthForcing {
  month: number;
  /** Saturation column water (kg/m²) and its inverse. */
  wsat: Float32Array;
  invWsat: Float32Array;
  /** Precipitation multiplier M (lee suppression included). */
  mult: Float32Array;
  /** Ocean evaporation E = max(0, evapA − r·evapB), kg m⁻² s⁻¹ (land fraction, ice, moisture applied). */
  evapA: Float32Array;
  evapB: Float32Array;
  /** Land PET × land fraction, kg m⁻² s⁻¹. */
  pet: Float32Array;
  /**
   * Land ET = min(pet, etCap·P + etMemory): etCap = β·lf by default; the annual solver splits β into
   * a current-month part and a memory of earlier months' precipitation (soil storage).
   */
  etCap: Float32Array;
  etMemory: Float32Array;
  /** Cold-SST stability seen by each cell (K ≥ 0). */
  stab: Float32Array;
  /** Eddy diffusivity (m²/s). */
  eddyK: Float32Array;
  /** Per-cell flux-form compression factor exp(−dt ∇·u_steer). */
  compression: Float32Array;
  /** Per-cell number of sink sub-steps (see moistureColumn.ts). */
  substeps: Uint8Array;
  /** Per-cell gate threshold r0 − storm-track shift. */
  gateR0: Float32Array;
  /**
   * Per-cell condensation reference for cloud: the gate threshold without the storm-track shift
   * (frontal cloud has its own regime in hydroCloud.ts).
   */
  cloudR0: Float32Array;
}

/** Scratch buffers reused across months. */
export interface ForcingScratch {
  work: Float64Array;
  divergence: Float64Array;
  blurred: Float64Array;
  zonalSst: Float64Array;
  zonalAir: Float64Array;
  zonalWeight: Float64Array;
  stabStencil: Stencil;
}

export function rmsAllMonths(g: HydroGrid, f: Float32Array): number {
  let s = 0;
  for (let m = 0; m < 12; m++) {
    const off = m * g.n;
    for (let r = 0; r < g.h; r++) {
      let row = 0;
      const o = off + r * g.w;
      for (let c = 0; c < g.w; c++) row += f[o + c] * f[o + c];
      s += row * g.rowArea[r];
    }
  }
  return Math.sqrt(s / 12);
}

export function computeStaticForcing(g: HydroGrid, dyn: DynamicsResult, t: HydroTuning): StaticForcing {
  const n = g.n;
  const hPlus = blurSphere(g, dyn.surfaceHeight, t.orographySmoothKm);
  const hGradX = new Float64Array(n);
  const hGradY = new Float64Array(n);
  gradient(g, hPlus, hGradX, hGradY);
  const aRms = rmsAllMonths(g, dyn.ascent);
  const bRms = rmsAllMonths(g, dyn.baroclinic);
  const landFrac = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lf = dyn.landFraction[i];
    landFrac[i] = lf > 1 ? 1 : lf > 0 ? lf : 0;
  }
  const tilt = dyn.params.axialTilt * DEG;
  const dayLength = new Float64Array(12 * g.h);
  for (let m = 0; m < 12; m++) {
    for (let r = 0; r < g.h; r++) dayLength[m * g.h + r] = monthDayLength(g.lat[r], m, tilt);
  }
  return {
    hSmooth: hPlus,
    hGradX,
    hGradY,
    ascentScale: aRms > 1e-30 ? aRms * t.ascentRmsScale : Infinity,
    baroclinicScale: bRms > 1e-30 ? bRms * t.baroclinicRmsScale : Infinity,
    landFrac,
    dayLength,
  };
}

export function allocMonthForcing(n: number): MonthForcing {
  const f = () => new Float32Array(n);
  return {
    month: -1,
    wsat: f(),
    invWsat: f(),
    mult: f(),
    evapA: f(),
    evapB: f(),
    pet: f(),
    etCap: f(),
    etMemory: f(),
    stab: f(),
    eddyK: f(),
    compression: f(),
    substeps: new Uint8Array(n),
    gateR0: f(),
    cloudR0: f(),
  };
}

export function allocForcingScratch(g: HydroGrid): ForcingScratch {
  return {
    work: new Float64Array(g.n),
    divergence: new Float64Array(g.n),
    blurred: new Float64Array(g.n),
    zonalSst: new Float64Array(g.h),
    zonalAir: new Float64Array(g.h),
    zonalWeight: new Float64Array(g.h),
    stabStencil: allocStencil(g.n),
  };
}

/**
 * Ocean-weighted zonal mean of a sea-level field per row (the latitude's reference value): ocean
 * cells weigh 1, land cells `landWeight` (so rows without ocean still get a defined, continuous
 * value), then a 1-2-1 meridional filter removes row-to-row jumps where the ocean share changes.
 * `seaLevelLapse` adds Γ·h⁺ on land (sea-level reduction of air temperature).
 */
function zonalReference(
  g: HydroGrid,
  dyn: DynamicsResult,
  field: Float32Array,
  off: number,
  landWeight: number,
  seaLevelLapse: boolean,
  weight: Float64Array,
  out: Float64Array,
): void {
  const { w, h } = g;
  for (let r = 0; r < h; r++) {
    let s = 0;
    let ws = 0;
    let plain = 0;
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const land = dyn.land[i] === 1;
      const wt = land ? landWeight : 1;
      const v = field[off + i] + (land && seaLevelLapse ? LAPSE_RATE * dyn.surfaceHeight[i] : 0);
      s += wt * v;
      ws += wt;
      plain += v;
    }
    // An all-land row with landWeight = 0 (calibration sweeps) falls back to the plain row mean.
    weight[r] = ws > 0 ? s / ws : plain / w;
  }
  for (let r = 0; r < h; r++) {
    const a = weight[r > 0 ? r - 1 : r];
    const b = weight[r < h - 1 ? r + 1 : r];
    out[r] = 0.25 * a + 0.5 * weight[r] + 0.25 * b;
  }
}

/**
 * Cold-SST stability: the ocean's cold anomaly relative to the latitude's reference SST,
 * T_ref(lat) − SST ≥ 0 (open water only), spread by a Gaussian and sampled upwind along the
 * steering wind, so cold upwelling coasts stabilize the air flowing off them.
 */
function computeStability(g: HydroGrid, dyn: DynamicsResult, off: number, t: HydroTuning, s: ForcingScratch, out: Float32Array): void {
  const { w, h } = g;
  const { zonalSst, work } = s;
  zonalReference(g, dyn, dyn.sst, off, t.referenceLandWeight, false, s.zonalWeight, zonalSst);
  for (let r = 0; r < h; r++) {
    const tref = zonalSst[r];
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (dyn.land[i]) {
        work[i] = 0;
        continue;
      }
      const a = tref - dyn.sst[off + i];
      work[i] = (a > 0 ? (a < t.stabilityMax ? a : t.stabilityMax) : 0) * (1 - dyn.seaIce[off + i]);
    }
  }
  blurSphere(g, work, t.stabilitySmoothKm, s.blurred);
  buildDepartureStencil(g, dyn.steerU, dyn.steerV, off, t.stabilityUpwindHours * 3600, 0, s.stabStencil);
  applyStencil(s.stabStencil, s.blurred, s.work, g.n);
  out.set(s.work);
}

/**
 * Precipitation multiplier M = max(M_min, 1 + c_c·Asc⁺ − c_s·Asc⁻ + c_f·Baro + c_o·Oro − c_st·Stab)
 * (capped at M_max) times the lee suppression exp(−k·max(0, −u·∇h⁺)). `asc`, `baro` are normalized,
 * `upslope` = u·∇h⁺ / orographicRefSpeed with the undeflected (steering) wind, `stab` in K.
 */
export function precipMultiplier(asc: number, baro: number, upslope: number, stab: number, t: HydroTuning): number {
  let m =
    1 +
    (asc > 0 ? t.ascentWeight * asc : t.subsidenceWeight * asc) +
    t.baroclinicWeight * baro +
    (upslope > 0 ? t.orographicWeight * upslope : 0) -
    t.stabilityWeight * stab;
  m = m < t.multiplierMin ? t.multiplierMin : m > t.multiplierMax ? t.multiplierMax : m;
  if (upslope < 0) {
    const lee = Math.exp(t.leeSuppression * upslope);
    m *= lee > t.leeFloor ? lee : t.leeFloor;
  }
  return m;
}

/**
 * Lowering of the gate threshold r0 by sub-monthly column-RH variance: averaging exp(a·r) over
 * fluctuations of variance σ² gives exp(a (r̄ − r0 + a σ²/2)). Variance sources: any land surface
 * (diurnal cycle), surface-heated convection over land warmer than the latitude (`warmAnomaly`,
 * K, sea-level reduced) and synoptic storms (baroclinic index). A subsidence inversion caps the
 * land terms (not the storms).
 */
export function gateThresholdShift(landFrac: number, warmAnomaly: number, asc: number, baro: number, t: HydroTuning): number {
  const capConv = asc < 0 ? 1 + t.subsidenceCapping * asc : 1;
  const capLand = asc < 0 ? 1 + t.subsidenceCappingLand * asc : 1;
  const warm = (landFrac * warmAnomaly) / t.landConvectionRefK;
  const storm = baro / t.baroclinicForMaxGateShift;
  const shift =
    (capLand > 0 ? capLand : 0) * t.landGateShift * landFrac +
    (capConv > 0 ? capConv : 0) * t.landConvectionGateShift * (warm > 1 ? 1 : warm > 0 ? warm : 0) +
    t.stormGateShift * (storm > 1 ? 1 : storm);
  return shift < t.gateShiftMax ? shift : t.gateShiftMax;
}

/** Fill `f` with the forcing of month m for pseudo-time step dt (s). */
export function computeMonthForcing(
  g: HydroGrid,
  dyn: DynamicsResult,
  st: StaticForcing,
  m: number,
  dt: number,
  t: HydroTuning,
  scratch: ForcingScratch,
  f: MonthForcing,
): void {
  const { w, h, n } = g;
  const off = m * n;
  f.month = m;
  computeStability(g, dyn, off, t, scratch, f.stab);
  zonalReference(g, dyn, dyn.temp, off, t.referenceLandWeight, true, scratch.zonalWeight, scratch.zonalAir);
  const div = scratch.divergence;
  divergence(g, dyn.steerU, dyn.steerV, off, div);
  const moisture = Math.max(0, dyn.params.moisture);
  const kEvap = t.airDensity * t.evapTransferCoeff * moisture;
  const gust2 = t.gustiness * t.gustiness;
  const invAsc = 1 / st.ascentScale;
  const invBaro = 1 / st.baroclinicScale;
  const invOroRef = 1 / t.orographicRefSpeed;
  const kRange = t.eddyDiffusivityMax - t.eddyDiffusivityMin;
  const invTauP = 1 / (t.precipTimescaleDays * 86400);
  const keepAnomaly = 1 - t.columnAnomalyDamping;
  for (let r = 0; r < h; r++) {
    const dayLen = st.dayLength[m * h + r];
    const tRef = scratch.zonalAir[r];
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const k = off + i;
      const T = dyn.temp[k];
      const lf = st.landFrac[i];

      // Column saturation: only part of the local sea-level anomaly (relative to the latitude's
      // reference) reaches the free troposphere; the lapse term keeps plateaus dry.
      const lapse = LAPSE_RATE * dyn.surfaceHeight[i];
      const tCol = tRef + keepAnomaly * (T + lapse - tRef) - lapse;
      const ws = saturationColumnWater(tCol, t.waterScaleHeight);
      f.wsat[i] = ws;
      f.invWsat[i] = 1 / ws;

      // Precipitation multiplier M and the humidity-gate threshold.
      const asc = dyn.ascent[k] * invAsc;
      const baro = Math.max(0, dyn.baroclinic[k] * invBaro);
      const upslope = (dyn.steerU[k] * st.hGradX[i] + dyn.steerV[k] * st.hGradY[i]) * invOroRef;
      const mult = precipMultiplier(asc, baro, upslope, f.stab[i], t);
      f.mult[i] = mult;
      // Ice-phase onset (Wegener–Bergeron–Findeisen): below 0 °C precipitation forms once the column
      // is saturated with respect to ice, e_si/e_sw of the liquid saturation used for W_sat.
      const icePhase = t.icePhaseGate > 0 && tCol < 0 ? 1 - t.icePhaseGate * (1 - iceToWaterSaturation(tCol)) : 1;
      const r0 = t.gateThreshold * icePhase - gateThresholdShift(lf, T + lapse - tRef, asc, baro, t);
      f.gateR0[i] = r0;
      f.cloudR0[i] = t.gateThreshold * icePhase - gateThresholdShift(lf, T + lapse - tRef, asc, 0, t);
      f.substeps[i] = substepsFor(mult, invTauP, t.gateSteepness, r0, dt, t.sinkStiffnessBound, t.maxSinkSubsteps);

      // Bulk ocean evaporation coefficients on the open-water fraction.
      const u = dyn.windU[k];
      const v = dyn.windV[k];
      const ice = dyn.seaIce[k];
      const kk = kEvap * Math.sqrt(u * u + v * v + gust2) * (1 - (ice > 1 ? 1 : ice < 0 ? 0 : ice)) * (1 - lf);
      f.evapA[i] = kk * satSpecificHumidity(dyn.sst[k]);
      f.evapB[i] = kk * satSpecificHumidity(T);

      // Land PET on the land fraction; ET = min(PET, β·P) unless the annual solver adds memory.
      f.pet[i] = lf > 0 ? lf * t.petScale * hamonPet(T, dayLen, t.petRampTemp) : 0;
      f.etCap[i] = t.etRecycling * lf;
      f.etMemory[i] = 0;

      const kFrac = baro / t.baroclinicForMaxDiffusivity;
      f.eddyK[i] = t.eddyDiffusivityMin + kRange * (kFrac > 1 ? 1 : kFrac);

      let d = t.divergenceWeight * div[i];
      d = d > t.divergenceMax ? t.divergenceMax : d < -t.divergenceMax ? -t.divergenceMax : d;
      f.compression[i] = Math.exp(-d * dt);
    }
  }
}
