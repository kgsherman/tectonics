/**
 * Sea-level pressure and surface winds on the core grid (SPEC §6.1.4–5).
 *
 * Pressure = zonal belts (ITCZ trough, subtropical highs, subpolar lows, polar highs) that follow a
 * per-longitude thermal equator, scaled by each hemisphere's meridional temperature gradient,
 * plus a thermal term −k·(T_slr − T_ref(lat)) for land/sea contrasts (heat lows, winter highs).
 * Winds solve the Rayleigh-friction balance  r·u + f k×u = −∇p/ρ  at all latitudes.
 */
import { OMEGA_EARTH } from '../core/constants';
import type { ClimateParams } from '../core/types';
import { EARTH_RADIUS_M, type LatLonGrid } from './dynGrid';
import { boxBlurZonal, smoothField } from './numerics';
import { pressureTuning, windTuning } from './tuning';

const DEG = Math.PI / 180;

export interface Circulation {
  /** hPa, 12·n. */
  pressure: Float64Array;
  /** Frictional surface wind, m/s. */
  windU: Float64Array;
  windV: Float64Array;
  /** Steering wind for moisture, m/s. */
  steerU: Float64Array;
  steerV: Float64Array;
  /**
   * Boundary-layer air-mass flow for heat advection, m/s: the steering wind without the
   * thermal-wind shear share (heatThermalShare of it), since near-surface air masses move with the
   * low-level flow.
   */
  heatU: Float64Array;
  heatV: Float64Array;
  /** Normalized large-scale ascent (frictional convergence), ~O(1). */
  ascent: Float64Array;
  /** Normalized storm-track proxy ≥ 0. */
  baroclinic: Float64Array;
  /** Per month and column: thermal-equator latitude (radians), 12·nx. */
  thermalEquator: Float64Array;
}

/** Signed Coriolis parameter per row. */
export function coriolis(g: LatLonGrid, retrograde: boolean): Float64Array {
  const f = new Float64Array(g.ny);
  const s = retrograde ? -1 : 1;
  for (let j = 0; j < g.ny; j++) f[j] = 2 * OMEGA_EARTH * g.sinLat[j] * s;
  return f;
}

/**
 * Reference temperature per row: zonal mean over ocean cells; rows without ocean are interpolated
 * from rows with ocean; with no ocean anywhere, the all-cell row mean.
 */
export function referenceTemperature(g: LatLonGrid, T: ArrayLike<number>, off: number, land: Uint8Array, out: Float64Array): void {
  const { nx, ny } = g;
  const have = new Uint8Array(ny);
  let anyOcean = false;
  for (let j = 0; j < ny; j++) {
    let s = 0;
    let k = 0;
    let sAll = 0;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      sAll += T[off + i];
      if (!land[i]) {
        s += T[off + i];
        k++;
      }
    }
    if (k >= Math.max(2, nx / 30)) {
      out[j] = s / k;
      have[j] = 1;
      anyOcean = true;
    } else out[j] = sAll / nx;
  }
  if (!anyOcean) return;
  for (let j = 0; j < ny; j++) {
    if (have[j]) continue;
    let a = j - 1;
    while (a >= 0 && !have[a]) a--;
    let b = j + 1;
    while (b < ny && !have[b]) b++;
    if (a >= 0 && b < ny) out[j] = out[a] + ((out[b] - out[a]) * (j - a)) / (b - a);
    else if (a >= 0) out[j] = out[a];
    else if (b < ny) out[j] = out[b];
  }
}

/** Soft-argmax latitude of the smoothed temperature per column, smoothed in longitude and clamped. */
function thermalEquator(g: LatLonGrid, Ts: Float64Array, tiltDeg: number, out: Float64Array, off: number): void {
  const P = pressureTuning;
  const { nx, ny } = g;
  const search = P.thermalEqSearch * DEG;
  const clamp = Math.min(Math.max(0, tiltDeg), P.thermalEqClamp) * DEG;
  const tmp = new Float64Array(nx);
  for (let c = 0; c < nx; c++) {
    let tMax = -Infinity;
    for (let j = 0; j < ny; j++) if (Math.abs(g.lat[j]) <= search && Ts[j * nx + c] > tMax) tMax = Ts[j * nx + c];
    let sw = 0;
    let sl = 0;
    for (let j = 0; j < ny; j++) {
      if (Math.abs(g.lat[j]) > search) continue;
      const w = Math.exp((Ts[j * nx + c] - tMax) / P.thermalEqSoftness) * g.cosLat[j];
      sw += w;
      sl += w * g.lat[j];
    }
    tmp[c] = sw > 0 ? sl / sw : 0;
  }
  const row = new Float64Array(nx);
  row.set(tmp);
  const hw = new Int32Array(1);
  hw[0] = Math.max(0, Math.round((P.thermalEqSmoothLon * DEG) / (2 * g.dLon)));
  const work = new Float64Array(nx);
  for (let p = 0; p < 3; p++) boxBlurZonal(row, 0, nx, 1, hw, work);
  for (let c = 0; c < nx; c++) out[off + c] = Math.max(-clamp, Math.min(clamp, row[c]));
}

/**
 * Subpolar-trough deepening [north, south] over a zonally open storm-track ocean: where the latitude
 * circle of the subpolar belt is (almost) all ocean, the storm track is zonally uniform and not
 * disrupted by continents and stationary waves, and the circumpolar trough is much deeper than the
 * NH's regional lows (Earth: ~985 hPa at 65°S vs ~1005 hPa for the Aleutian/Icelandic lows).
 * Factor 1 + channelBoost·clamp((f_ocean − channelStart)/(1 − channelStart)) with f_ocean the
 * area-mean ocean fraction of the band [subpolarLat − channelBandLow, subpolarLat + channelBandHigh].
 */
function subpolarChannelFactors(g: LatLonGrid, landFrac: Float64Array): [number, number] {
  const P = pressureTuning;
  const band = (sign: number): number => {
    let s = 0, w = 0;
    for (let j = 0; j < g.ny; j++) {
      const la = (g.lat[j] / DEG) * sign;
      if (la < P.subpolarLat - P.channelBandLow || la > P.subpolarLat + P.channelBandHigh) continue;
      let r = 0;
      for (let c = 0; c < g.nx; c++) r += 1 - landFrac[j * g.nx + c];
      s += (r / g.nx) * g.area[j];
      w += g.area[j];
    }
    const f = w > 0 ? s / w : 0;
    const x = Math.min(1, Math.max(0, (f - P.channelStart) / Math.max(1e-6, 1 - P.channelStart)));
    return 1 + P.channelBoost * x;
  };
  return [band(1), band(-1)];
}

/** Hemispheric gradient scale factors [north, south] from the zonal-mean temperature. */
function gradientScales(g: LatLonGrid, T: Float64Array, off: number): [number, number] {
  const P = pressureTuning;
  const band = (lo: number, hi: number, sign: number): number => {
    let s = 0;
    let w = 0;
    for (let j = 0; j < g.ny; j++) {
      const la = (g.lat[j] / DEG) * sign;
      if (la < lo || la > hi) continue;
      let r = 0;
      for (let c = 0; c < g.nx; c++) r += T[off + j * g.nx + c];
      s += (r / g.nx) * g.area[j];
      w += g.area[j];
    }
    return w > 0 ? s / w : 0;
  };
  const sc = (sign: number): number => {
    const G = band(0, 30, sign) - band(50, 80, sign);
    const r = Math.max(0, G / P.gradientRef);
    return Math.max(P.gradientScaleMin, Math.min(P.gradientScaleMax, Math.pow(r, P.gradientExponent)));
  };
  return [sc(1), sc(-1)];
}

/**
 * Compute monthly pressure, winds, steering winds, ascent and baroclinicity from the monthly
 * sea-level-reduced air temperature `tSl` (12·n) on grid g.
 */
export function computeCirculation(g: LatLonGrid, tSl: Float64Array, land: Uint8Array, landFrac: Float64Array, params: ClimateParams): Circulation {
  const P = pressureTuning;
  const W = windTuning;
  const { nx, ny, n } = g;
  const pressure = new Float64Array(12 * n);
  const windU = new Float64Array(12 * n);
  const windV = new Float64Array(12 * n);
  const steerU = new Float64Array(12 * n);
  const steerV = new Float64Array(12 * n);
  const heatU = new Float64Array(12 * n);
  const heatV = new Float64Array(12 * n);
  const ascent = new Float64Array(12 * n);
  const baroclinic = new Float64Array(12 * n);
  const thermalEq = new Float64Array(12 * nx);

  // Static fields: smoothed land fraction for belt amplitudes and for friction across coasts.
  const lfBelt = Float64Array.from(landFrac);
  const [openN, openS] = subpolarChannelFactors(g, landFrac);
  smoothField(g, lfBelt, P.beltLandSmoothKm, 3);
  const lfCoast = Float64Array.from(landFrac);
  smoothField(g, lfCoast, W.coastSmoothKm, 3);
  const f = coriolis(g, params.retrograde);
  const Tref = new Float64Array(ny);
  const Ts = new Float64Array(n);
  const th = new Float64Array(n);

  for (let m = 0; m < 12; m++) {
    const off = m * n;
    // Thermal term.
    // Reference: zonal ocean mean, optionally blended (refAllCellWeight; currently 0 = the SPEC's
    // ocean-only reference) with the all-cell zonal mean, which would also imprint the opposite
    // of the continental heating/cooling on the oceans.
    referenceTemperature(g, tSl, off, land, Tref);
    for (let j = 0; j < ny; j++) {
      let s = 0;
      for (let c = 0; c < nx; c++) s += tSl[off + j * nx + c];
      Tref[j] += P.refAllCellWeight * (s / nx - Tref[j]);
    }
    for (let j = 0; j < ny; j++) {
      for (let c = 0; c < nx; c++) {
        const i = j * nx + c;
        const d = -P.thermalK * (tSl[off + i] - Tref[j]);
        th[i] = Math.max(-P.thermalMax, Math.min(P.thermalMax, d));
      }
    }
    smoothField(g, th, P.thermalSmoothKm, 3);
    // Thermal equator & belt scaling.
    for (let i = 0; i < n; i++) Ts[i] = tSl[off + i];
    smoothField(g, Ts, 500, 2);
    thermalEquator(g, Ts, params.axialTilt, thermalEq, m * nx);
    const [sN, sS] = gradientScales(g, tSl, off);
    const sEq = 0.5 * (sN + sS);
    for (let j = 0; j < ny; j++) {
      const la = g.lat[j] / DEG;
      for (let c = 0; c < nx; c++) {
        const i = j * nx + c;
        const te = thermalEq[m * nx + c] / DEG;
        const d = la - te;
        const phiE = la - te * Math.exp(-(d * d) / (P.shiftDecay * P.shiftDecay));
        const a = Math.abs(phiE);
        const sH = phiE >= 0 ? sN : sS;
        // Subtropical anticyclones are oceanic cells; over continents the thermal term takes over
        // (winter continental highs, summer heat lows).
        const ampSt = P.subtropicalAmp * (1 - (1 - P.subtropicalLandFactor) * lfBelt[i]);
        const ampSp = (P.subpolarAmpLand + (P.subpolarAmpOcean - P.subpolarAmpLand) * (1 - lfBelt[i])) * (phiE >= 0 ? openN : openS);
        const belt =
          -P.itczDepth * sEq * gauss(phiE, 0, P.itczWidth) +
          sH * (ampSt * gauss(a, P.subtropicalLat, P.subtropicalWidth) - ampSp * gauss(a, P.subpolarLat, P.subpolarWidth) + P.polarAmp * gauss(a, 90, P.polarWidth));
        pressure[off + i] = P.base + belt + th[i];
      }
    }
    smoothField(g, pressure, P.finalSmoothKm, 3, off);
    windsFromPressure(g, pressure, off, f, lfCoast, windU, windV);
    polarFilter(g, windU, off);
    polarFilter(g, windV, off);
    capSpeed(windU, windV, off, n, W.maxSpeed);
    steering(g, windU, windV, off, f, lfCoast, Ts, steerU, steerV, heatU, heatV);
    // The thermal-wind shear is a zonal finite difference, whose cells shrink toward the poles:
    // filter it like the surface wind (the cross-pole flow, zonal wavenumber 1, passes).
    polarFilter(g, steerU, off);
    polarFilter(g, steerV, off);
    polarFilter(g, heatU, off);
    polarFilter(g, heatV, off);
    convergence(g, windU, windV, off, ascent);
    smoothField(g, ascent, W.ascentSmoothKm, 3, off);
    for (let i = 0; i < n; i++) ascent[off + i] /= W.ascentRef;
    baroclinicity(g, Ts, steerU, steerV, off, params.retrograde, baroclinic);
    smoothField(g, baroclinic, W.baroSmoothKm, 3, off);
  }
  return { pressure, windU, windV, steerU, steerV, heatU, heatV, ascent, baroclinic, thermalEquator: thermalEq };
}

function gauss(x: number, mu: number, w: number): number {
  const d = (x - mu) / w;
  return Math.exp(-d * d);
}

/**
 * Rayleigh friction r (s⁻¹) for Coriolis parameter f and smoothed land fraction lf: a constant
 * boundary-layer turning angle α (r = |f|·tan α, the Ekman-layer cross-isobar angle is nearly
 * independent of latitude) with a floor rMin near the equator, blended ocean → land. With
 * frictionAngleOcean ≤ 0 the constant rOcean / rLand are used.
 */
export function friction(f: number, lf: number): number {
  const W = windTuning;
  if (!(W.frictionAngleOcean > 0)) return W.rOcean + (W.rLand - W.rOcean) * lf;
  const af = Math.abs(f);
  const ro = Math.max(W.rMinOcean, af * Math.tan(W.frictionAngleOcean * DEG));
  const rl = Math.max(W.rMinLand, af * Math.tan(W.frictionAngleLand * DEG));
  return ro + (rl - ro) * lf;
}

/** Rayleigh-friction balance u = (r·g − f k×g)/(r² + f²), g = −∇p/ρ. */
export function windsFromPressure(
  g: LatLonGrid,
  p: Float64Array,
  off: number,
  f: Float64Array,
  lfCoast: Float64Array,
  U: Float64Array,
  V: Float64Array,
): void {
  const W = windTuning;
  const { nx, ny } = g;
  const R = EARTH_RADIUS_M;
  for (let j = 0; j < ny; j++) {
    const dx = 2 * R * g.cosLat[j] * g.dLon;
    const jn = j > 0 ? j - 1 : j;
    const js = j < ny - 1 ? j + 1 : j;
    const dy = R * g.dLat * (js - jn);
    const fj = f[j];
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const ce = c === nx - 1 ? 0 : c + 1;
      const cw = c === 0 ? nx - 1 : c - 1;
      // hPa → Pa.
      const px = (100 * (p[off + j * nx + ce] - p[off + j * nx + cw])) / dx;
      const py = (100 * (p[off + jn * nx + c] - p[off + js * nx + c])) / dy;
      const r = friction(fj, lfCoast[i]);
      const den = W.rhoAir * (r * r + fj * fj);
      U[off + i] = -(r * px + fj * py) / den;
      V[off + i] = -(r * py - fj * px) / den;
    }
  }
}

/** Zonal smoothing poleward of polarFilterLat with half-width growing like 1/cosφ. */
function polarFilter(g: LatLonGrid, F: Float64Array, off: number): void {
  const W = windTuning;
  const c0 = Math.cos(W.polarFilterLat * DEG);
  const hx = new Int32Array(g.ny);
  for (let j = 0; j < g.ny; j++) {
    const cl = g.cosLat[j];
    hx[j] = cl < c0 ? Math.min(Math.floor((g.nx - 1) / 2), Math.round(2 * (c0 / cl - 1) * 2)) : 0;
  }
  const tmp = new Float64Array(g.nx);
  for (let p = 0; p < 2; p++) boxBlurZonal(F, off, g.nx, g.ny, hx, tmp);
}

function capSpeed(U: Float64Array, V: Float64Array, off: number, n: number, vmax: number): void {
  for (let i = off; i < off + n; i++) {
    const s = Math.sqrt(U[i] * U[i] + V[i] * V[i]);
    if (s > vmax) {
      U[i] *= vmax / s;
      V[i] *= vmax / s;
    }
  }
}

/**
 * Steering wind (the flow that carries moisture and heat, ~850 hPa): frictional wind rotated
 * half-way back toward geostrophic, ×steerFactor, plus the thermal wind up to steerThermalHeight
 * (westerlies strengthen with height over a poleward temperature decrease: the polar vortex aloft
 * is westerly above shallow surface easterlies).
 */
function steering(
  g: LatLonGrid,
  U: Float64Array,
  V: Float64Array,
  off: number,
  f: Float64Array,
  lfCoast: Float64Array,
  Ts: Float64Array,
  SU: Float64Array,
  SV: Float64Array,
  HU: Float64Array,
  HV: Float64Array,
): void {
  const W = windTuning;
  const { nx, ny } = g;
  const R = EARTH_RADIUS_M;
  const fMin = 2 * OMEGA_EARTH * Math.sin(W.steerThermalMinLat * DEG);
  for (let j = 0; j < ny; j++) {
    const fj = f[j];
    const taper = Math.min(1, Math.abs(g.lat[j]) / (W.steerEquatorTaper * DEG));
    // Thermal wind to the moisture-carrying level: Δu = −(g Δz/(f T₀)) ∂T/∂y, Δv = (g Δz/(f T₀)) ∂T/∂x
    // (|f| floored at f(steerThermalMinLat) and faded toward the equator, where the balance fails).
    const fEff = fj === 0 ? 0 : Math.sign(fj) * Math.max(fMin, Math.abs(fj));
    // Extratropical only: equatorward of steerThermalFadeLat the moisture-carrying layer lies below
    // the trade inversion and follows the low-level (monsoon, trade) flow.
    const absLat = Math.abs(g.lat[j]) / DEG;
    const fade = W.steerThermalFadeLat > 0
      ? Math.min(1, Math.max(0, (absLat - W.steerThermalFadeLat) / W.steerThermalFadeWidth))
      : Math.min(1, absLat / (2 * W.steerThermalMinLat));
    const kT = fEff === 0 ? 0 : (fade * 9.81 * W.steerThermalHeight) / (fEff * 273);
    const jn = j > 0 ? j - 1 : j;
    const js = j < ny - 1 ? j + 1 : j;
    const dy = R * g.dLat * (js - jn);
    const dx = 2 * R * g.cosLat[j] * g.dLon;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const r = friction(fj, lfCoast[i]);
      // Cross-isobar angle atan(r/|f|); rotate clockwise (NH, f > 0) by half of it.
      const theta = fj === 0 ? 0 : -Math.sign(fj) * 0.5 * Math.atan(r / Math.abs(fj)) * taper;
      const cs = Math.cos(theta), sn = Math.sin(theta);
      const u = U[off + i], v = V[off + i];
      let du = 0;
      let dv = 0;
      if (kT !== 0) {
        const ce = c === nx - 1 ? 0 : c + 1;
        const cw = c === 0 ? nx - 1 : c - 1;
        const dTdy = (Ts[jn * nx + c] - Ts[js * nx + c]) / dy;
        const dTdx = (Ts[j * nx + ce] - Ts[j * nx + cw]) / dx;
        du = -kT * dTdy;
        dv = kT * dTdx;
        const s = Math.sqrt(du * du + dv * dv);
        if (s > W.steerThermalMax) {
          du *= W.steerThermalMax / s;
          dv *= W.steerThermalMax / s;
        }
      }
      SU[off + i] = W.steerFactor * (u * cs - v * sn) + du;
      SV[off + i] = W.steerFactor * (u * sn + v * cs) + dv;
      HU[off + i] = W.steerFactor * (u * cs - v * sn) + W.heatThermalShare * du;
      HV[off + i] = W.steerFactor * (u * sn + v * cs) + W.heatThermalShare * dv;
    }
  }
}

/** Finite-volume convergence −∇·u (s⁻¹). */
function convergence(g: LatLonGrid, U: Float64Array, V: Float64Array, off: number, out: Float64Array): void {
  const { nx, ny } = g;
  const R = EARTH_RADIUS_M;
  for (let j = 0; j < ny; j++) {
    const aR = R * g.area[j];
    for (let c = 0; c < nx; c++) {
      const i = off + j * nx + c;
      const ce = off + j * nx + (c === nx - 1 ? 0 : c + 1);
      const cw = off + j * nx + (c === 0 ? nx - 1 : c - 1);
      const ue = 0.5 * (U[i] + U[ce]);
      const uw = 0.5 * (U[i] + U[cw]);
      const vn = j > 0 ? 0.5 * (V[i] + V[i - nx]) * g.faceCos[j] : 0;
      const vs = j < ny - 1 ? 0.5 * (V[i] + V[i + nx]) * g.faceCos[j + 1] : 0;
      const div = ((ue - uw) * g.dLat + (vn - vs) * g.dLon) / aR;
      out[i] = -div;
    }
  }
}

/**
 * |∂T/∂y| (K per 1000 km) × (max(0, westerly component) + baroSpeedWeight·|u|), normalized: storms
 * grow on the meridional temperature gradient and are steered by the flow; the speed term keeps
 * frontal activity where the mean flow is weak or easterly (polar fronts, the Arctic).
 */
function baroclinicity(g: LatLonGrid, Ts: Float64Array, SU: Float64Array, SV: Float64Array, off: number, retrograde: boolean, out: Float64Array): void {
  const W = windTuning;
  const { nx, ny } = g;
  const sgn = retrograde ? -1 : 1;
  const dy = (EARTH_RADIUS_M * g.dLat) / 1e6;
  for (let j = 0; j < ny; j++) {
    const jn = j > 0 ? j - 1 : j;
    const js = j < ny - 1 ? j + 1 : j;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const grad = Math.abs(Ts[jn * nx + c] - Ts[js * nx + c]) / (dy * (js - jn));
      const su = SU[off + i];
      const sv = SV[off + i];
      out[off + i] = (grad * (Math.max(0, sgn * su) + W.baroSpeedWeight * Math.sqrt(su * su + sv * sv))) / W.baroRef;
    }
  }
}
