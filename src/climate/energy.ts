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
 * Land snow and ice (energyStep.ts, energyIce.ts): a mass M per land cell gains Clausius–Clapeyron
 * scaled snowfall and loses melt (a snow or ice surface cannot warm above 0 °C; the surplus melts
 * it). Perennial mass is glacier: ice-sheet albedo, and once a year an ice-flow budget feeds each
 * sheet's ablation zone from its accumulation surplus and a plastic-ice profile raises its surface.
 * Sea ice carries volume (−E) and area separately (Hibler 1979), with basal ocean heat.
 *
 * State per cell:
 *  - T    : air temperature, sea-level reduced over land (the transported field),
 *  - E    : ocean enthalpy J/m² (E ≥ 0: mixed layer T_o = T_f + E/C_o; E < 0: sea-ice volume −E/L,
 *           open water at T_f),
 *  - Ai   : sea-ice area fraction,
 *  - Ti   : sea-ice surface temperature,
 *  - Tann : running annual-mean surface temperature,
 *  - M    : land snow / ice mass, kg/m² water equivalent.
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
import { overturningHeating } from './energyOverturning';
import { ebmTuning } from './tuning';

export const SECONDS_PER_YEAR = 365.2422 * 86400;

export interface EbmModel {
  g: LatLonGrid;
  land: Uint8Array;
  /** Γ·(surface height above sea level) per land cell (K), including the ice-sheet raise; 0 over ocean. */
  lapse: Float64Array;
  /** Bed (input) height above sea level per land cell (m); 0 over ocean. */
  bedHeight: Float64Array;
  /** Ice-sheet surface raise above the bed per land cell (m, energyIce.ts). */
  iceRaise: Float64Array;
  /** Ice flow budget (energyIce.ts): glacier mask at the start of the year, the year's snowfall and melt (kg/m²), years integrated. */
  iceMask: Uint8Array;
  accY: Float64Array;
  ablY: Float64Array;
  /** Smallest land snow/ice mass of the current year (kg/m²). */
  minY: Float64Array;
  iceYears: number;
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
  /** Interhemispheric overturning heat source per ocean cell (W/m²), or null (energyOverturning.ts). */
  overturning: Float64Array | null;
  eFull: number;
  eMax: number;
  work: EbmWork;
}

export interface EbmState {
  T: Float64Array;
  E: Float64Array;
  /**
   * Heat (J/m², ≥ 0) of the seasonal stratified surface layer above the (winter-depth) mixed layer:
   * spring/summer heating warms a thin layer (stratDepth) that the wind and autumn convection mix
   * back down; the surface temperature is T_f + E/C_o + Es/C_s.
   */
  Es: Float64Array;
  Ti: Float64Array;
  /** Running annual mean of the surface temperature (1-year e-folding), °C. */
  Tann: Float64Array;
  /** Sea-ice area fraction 0..1 of ocean cells (the volume is −E / iceLatent per cell area). */
  Ai: Float64Array;
  /**
   * Land snow and ice mass, kg/m² water equivalent (0 over the ocean): seasonal snowpack below
   * ebmTuning.glacierMassLow, glacier / ice sheet above (see glacierWeight).
   */
  M: Float64Array;
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
  /**
   * Per month (12·n): planetary-albedo offset from the dynamics' cloud structure (land and open
   * water): clear skies under subsidence, persistent storm-track and marine stratocumulus decks.
   */
  albedoOffset: Float64Array | null;
  sea: SLStencil[] | null;
  /** Nearest ocean cell per cell (extends SST under land before advection). */
  nearestOcean: Int32Array | null;
  /** Upwelling damping λ_u = ρc·w⁺·efficiency, W/m²/K, 12·n. */
  upwellLambda: Float64Array | null;
  /** Temperature of upwelled water per cell, °C. */
  tSub: Float64Array | null;
}

export const NO_COUPLING: EbmCoupling = { air: null, airWarm: null, airCold: null, albedoOffset: null, sea: null, nearestOcean: null, upwellLambda: null, tSub: null };

/** Monthly means (12·n each): air temperature (sea-level reduced over land), SST, sea-ice fraction. */
export interface EbmMonthly {
  tAir: Float64Array;
  sst: Float64Array;
  ice: Float64Array;
  /** n: smallest land snow/ice mass of the year (kg/m²): the perennial (glacier) part. */
  mMin: Float64Array;
}

/** Scratch buffers of the integrator (energyStep.ts). */
export interface EbmWork {
  F: Float64Array;
  dep: Float64Array;
  To: Float64Array;
  tAirMean: Float64Array;
  /** Per-cell stability factor and the scaled air diffusion couplings (stable land surfaces). */
  stab: Float64Array;
  kE2: Float64Array;
  kN2: Float64Array;
  kS2: Float64Array;
  cEff: Float64Array;
  ice: Float64Array;
  /** Melt coupling of the land snow/ice surface this step (W/m²/K). */
  melt: Float64Array;
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

/**
 * Diffusivity D(φ) on the unit sphere (W/m²/K). `meridional` faces carry the Hadley enhancement:
 * the thermally direct tropical overturning moves heat across a nearly flat temperature profile
 * (weak temperature gradients in the tropics, Lindzen & Farrell 1977), i.e. a large effective
 * diffusivity inside |φ| ≲ hadleyLat with a sharp (super-Gaussian) edge.
 */
export function diffusivity(sinPhi: number, meridional = false, tiltDeg = 23.44): number {
  const s2 = sinPhi * sinPhi;
  const t = ebmTuning;
  let d = t.diffusion * Math.max(0.05, 1 + t.diffusionD2 * s2 + t.diffusionD4 * s2 * s2);
  // At high obliquity the annual-mean insolation maximum leaves the equator and the overturning
  // follows the sun across the hemisphere: the fixed equatorial enhancement fades out.
  const tiltFade = Math.min(1, Math.max(0, (t.hadleyTiltMax - tiltDeg) / (t.hadleyTiltMax - t.hadleyTiltFull)));
  if (t.hadleyBoost > 0 && tiltFade > 0) {
    const x = Math.asin(Math.max(-1, Math.min(1, sinPhi))) / ((t.hadleyLat * Math.PI) / 180);
    const w = Math.exp(-Math.pow(x * x, t.hadleyPower / 2));
    d *= 1 + tiltFade * (meridional ? t.hadleyBoost : t.hadleyBoost * t.hadleyZonalFactor) * w;
  }
  return d;
}

export function makeEbmModel(g: LatLonGrid, land: Uint8Array, height: Float64Array, params: ClimateParams, stepsPerMonth: number): EbmModel {
  const t = ebmTuning;
  const { nx, ny, n } = g;
  const stepsPerYear = 12 * stepsPerMonth;
  const lapse = new Float64Array(n);
  const freeTrop = new Float64Array(n);
  const bedHeight = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    bedHeight[i] = land[i] ? Math.max(0, height[i]) : 0;
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
    const kx = (diffusivity(s, false, params.axialTilt) * g.dLat) / (g.cosLat[j] * g.dLon * g.area[j]);
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const e = j * nx + (c === nx - 1 ? 0 : c + 1);
      kE[i] = kx * 0.5 * (fc(i) + fc(e));
    }
  }
  for (let j = 0; j + 1 < ny; j++) {
    // Face between rows j and j+1 at faceSin[j+1]: length dλ·cosφ_f, center distance dφ.
    const flux = (diffusivity(g.faceSin[j + 1], true, params.axialTilt) * g.dLon * g.faceCos[j + 1]) / g.dLat;
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
    // Zonal SST contrasts (upwelling tongues, warm pools) are set by currents and upwelling, which
    // the model resolves; the diffusion mainly stands in for unresolved meridional transport.
    const kx = (Do * t.oceanZonalDiffusionFactor * g.dLat) / (g.cosLat[j] * g.dLon * g.area[j]);
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const e = j * nx + (c === nx - 1 ? 0 : c + 1);
      if (!land[i] && !land[e]) oE[i] = kx;
    }
  }
  // Zonally open channels (a circumpolar ocean) block meridional ocean heat transport: no zonal
  // pressure gradient can support a mean geostrophic meridional flow and there are no western
  // boundary currents, so only eddies cross the channel (the Drake Passage effect).
  const open = new Float64Array(ny);
  for (let j = 0; j < ny; j++) {
    let best = 0;
    let run = 0;
    let all = true;
    for (let k = 0; k < 2 * nx; k++) {
      if (!land[j * nx + (k % nx)]) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
        all = false;
      }
    }
    open[j] = all ? 1 : Math.min(1, best / nx);
  }
  for (let j = 0; j + 1 < ny; j++) {
    const o = Math.pow(Math.max(open[j], open[j + 1]), t.channelDiffusionPower);
    const flux = ((Do * g.dLon * g.faceCos[j + 1]) / g.dLat) * (1 - (1 - t.channelDiffusionFactor) * o);
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
    stab: new Float64Array(n), kE2: new Float64Array(n), kN2: new Float64Array(n), kS2: new Float64Array(n),
    cEff: new Float64Array(n), ice: new Float64Array(n), melt: new Float64Array(n),
    ra: new Float64Array(m), rb: new Float64Array(m), rc: new Float64Array(m), rd: new Float64Array(m), rx: new Float64Array(m),
    ca: new Float64Array(m), cb: new Float64Array(m), cc: new Float64Array(m), cd: new Float64Array(m), cx: new Float64Array(m),
    cp: new Float64Array(m), cyc: makeCyclicWork(nx),
  };
  return {
    g, land, lapse, bedHeight, iceRaise: new Float64Array(n), iceMask: new Uint8Array(n), accY: new Float64Array(n), ablY: new Float64Array(n), minY: new Float64Array(n), iceYears: 0, freeTrop, stepsPerMonth, stepsPerYear, dt: SECONDS_PER_YEAR / stepsPerYear,
    insol: insolationTable(g, stepsPerYear, params.axialTilt, params.solarMultiplier),
    albLand, albWater, cOcean, kE, kN, kS, oE, oN, oS, overturning: scaleOverturning(overturningHeating(g, land), params.oceanCurrents), eFull, eMax, work,
  };
}

function scaleOverturning(q: Float64Array | null, scale: number): Float64Array | null {
  if (!q || !(scale > 0)) return null;
  if (scale !== 1) for (let i = 0; i < q.length; i++) q[i] *= scale;
  return q;
}

export function makeState(n: number): EbmState {
  return { T: new Float64Array(n), E: new Float64Array(n), Es: new Float64Array(n), Ti: new Float64Array(n), Tann: new Float64Array(n), Ai: new Float64Array(n), M: new Float64Array(n) };
}

export function cloneState(s: EbmState): EbmState {
  return { T: s.T.slice(), E: s.E.slice(), Es: s.Es.slice(), Ti: s.Ti.slice(), Tann: s.Tann.slice(), Ai: s.Ai.slice(), M: s.M.slice() };
}

export function makeMonthly(n: number): EbmMonthly {
  return { tAir: new Float64Array(12 * n), sst: new Float64Array(12 * n), ice: new Float64Array(12 * n), mMin: new Float64Array(n) };
}

/** Snow/ice albedo ramp weight (0 = snow-free, 1 = full snow) on surface temperature. */
export function snowWeight(ts: number): number {
  const t = ebmTuning;
  const r = (t.snowRampWarm - ts) / (t.snowRampWarm - t.snowRampCold);
  return r <= 0 ? 0 : r >= 1 ? 1 : r;
}

/**
 * Fraction of the snow albedo effect realized on land: seasonal snow on high terrain is patchy
 * (wind-scoured, sublimating, rock and forest exposed) unless the surface is an ice sheet
 * (`glacier` weight 0..1, see glacierWeight). Γh = lapse (K) of the cell.
 */
export function snowCoverFactor(glacier: number, lapseK: number): number {
  const t = ebmTuning;
  const x = lapseK / (LAPSE_RATE * t.snowPatchyHeight);
  return Math.max(glacier, 1 / (1 + x * x));
}

/** Glacier weight 0..1 of a land snow/ice mass M (kg/m² w.e.). */
export function glacierWeight(M: number): number {
  const t = ebmTuning;
  const u = (M - t.glacierMassLow) / (t.glacierMassHigh - t.glacierMassLow);
  return u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
}

/** Snow cover fraction of a land snow/ice mass M (kg/m² w.e.). */
export function snowMassCover(M: number): number {
  return M > 0 ? 1 - Math.exp(-M / ebmTuning.snowCoverMass) : 0;
}

/** Snowfall rate (kg/m²/s) for surface air temperature ts (°C): Clausius–Clapeyron-scaled precipitation × snow fraction. */
export function snowfallRate(ts: number): number {
  const t = ebmTuning;
  const f = (t.snowfallWarm - ts) / (t.snowfallWarm - t.snowfallCold);
  if (f <= 0) return 0;
  return ((f >= 1 ? 1 : f) * t.snowfallRef * Math.exp(t.snowfallPerK * (ts < 0 ? ts : 0))) / SECONDS_PER_YEAR;
}

/** 0..1: how much a land cell with this annual-mean surface temperature behaves as an ice sheet. */
export function iceSheetWeight(tAnnualSurface: number): number {
  return Math.min(1, Math.max(0, (ebmTuning.snowPolarWarm - tAnnualSurface) / 10));
}

/** Sea-ice fraction for an ocean enthalpy with a single ice thickness eFull / iceLatent (initial states). */
export function iceFraction(E: number, eFull: number): number {
  return E >= 0 ? 0 : Math.min(1, -E / eFull);
}

/**
 * Sea-ice area after the ocean enthalpy changed from eOld to eNew with area a before: new ice
 * (from open water) has the lead-closing thickness; net melt removes the thin end of the thickness
 * distribution (Hibler 1979: dA = (A/2h)·dV, h = V/A); growth under existing ice thickens it. The
 * mean thickness of the ice part stays ≥ seaIceMinThickness.
 */
export function iceAreaAfter(eOld: number, eNew: number, a: number): number {
  if (eNew >= 0) return 0;
  const t = ebmTuning;
  const vNew = -eNew / t.iceLatent;
  let an: number;
  if (eOld >= 0 || !(a > 0)) an = vNew / t.seaIceLeadThickness;
  else {
    const vOld = -eOld / t.iceLatent;
    an = vNew < vOld ? a - ((a * a) / (2 * vOld)) * (vOld - vNew) : a;
  }
  const cap = vNew / t.seaIceMinThickness;
  if (an > cap) an = cap;
  return an > 1 ? 1 : an > 0 ? an : 0;
}

/** Surface warming (K) of the seasonal stratified layer holding heat Es (J/m²); 0 when disabled. */
export function stratTemperature(es: number): number {
  const t = ebmTuning;
  return t.stratDepth > 0 && es > 0 ? es / (t.rhoCpWater * t.stratDepth) : 0;
}

/** Set the ocean cells' air temperature to their surface temperature (initialization). */
export function syncOceanAirT(M: EbmModel, S: EbmState): void {
  const { g, land, cOcean } = M;
  const Tf = ebmTuning.freezeT;
  for (let j = 0; j < g.ny; j++) {
    const Co = cOcean[j];
    for (let c = 0; c < g.nx; c++) {
      const i = j * g.nx + c;
      if (land[i]) continue;
      const E = S.E[i];
      const a = E < 0 ? S.Ai[i] : 0;
      S.T[i] = (1 - a) * (Tf + Math.max(0, E) / Co + stratTemperature(S.Es[i])) + a * S.Ti[i];
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
