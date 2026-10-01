/**
 * Climate dynamics entry point (SPEC §6.1) → DynamicsResult (src/climate/internal.ts).
 *
 *   input → output surface (gridW×gridH) → core grid (2°, 3° fast)
 *   pass 1: energy balance without currents (steady solve → periodic init → years + Aitken)
 *           → pressure & winds → Stommel currents, Ekman upwelling
 *   pass 2: energy balance with air advection by the boundary-layer flow (terrain-aware),
 *           mixed-layer advection by currents, upwelling cooling toward a tilted-thermocline T_sub
 *           and cloud-regime albedo offsets (dynCloud.ts), started from the pass-1 state (years +
 *           Aitken) or from a previous result (warm start)
 *   → final pressure/winds/currents from the pass-2 temperatures → output grid.
 */
import { LAPSE_RATE } from '../core/constants';
import type { ClimateInput, ClimateParams } from '../core/types';
import type { DynamicsResult } from './internal';
import { computeCirculation, type Circulation } from './circulation';
import { applyStencil, buildStencil, type SLStencil } from './dynAdvect';
import { cloudAlbedoOffset } from './dynCloud';
import { globalMean } from './dynGrid';
import { prepareCoreSurface, prepareOutputSurface, warmState, type WarmFields } from './dynInput';
import { assembleOutput } from './dynOutput';
import {
  NO_COUPLING, aitkenExtrapolate, cloneState, makeEbmModel, makeMonthly, makeState,
  type EbmCoupling, type EbmModel, type EbmMonthly, type EbmState,
} from './energy';
import { integrateYear } from './energyStep';
import { periodicInit, steadyAnnualMean } from './energySteady';
import { nearestValidIndex } from './numerics';
import { computeOcean, makeOceanContext, type OceanResult } from './ocean';
import { subsurfaceTemperature } from './oceanSubsurface';
import { ebmTuning, gridTuning, spinupTuning } from './tuning';

const now = (): number => globalThis.performance?.now?.() ?? Date.now();

export type DynamicsWarmStart = WarmFields;

/**
 * DynamicsResult plus the glacier / ice-sheet cover of land cells (w·h, 0..1) from the land snow/ice
 * mass balance (not part of the internal contract; the hydrology reads it when present).
 */
export interface DynamicsResultWithIce extends DynamicsResult {
  landIce?: Float32Array;
  /** w·h ice-sheet surface raise above the bed (m): temperatures of land cells refer to surfaceHeight + iceRaise. */
  iceRaise?: Float32Array;
}

/**
 * Compute the monthly dynamics fields for `input` on the params.gridW × gridH output grid.
 * `warm` (a previous ClimateResult / DynamicsResult on any grid) seeds the coupled pass 2 in place
 * of the pass-1 end state (pass 1 itself always runs from the steady/periodic initialization), so
 * warm restarts converge to the cold-start climate. Deterministic for identical arguments.
 */
export function computeDynamics(
  input: ClimateInput,
  params: ClimateParams,
  warm?: DynamicsWarmStart | null,
  onProgress?: (fraction: number) => void,
): DynamicsResultWithIce {
  const timings: Record<string, number> = {};
  const stats: Record<string, number> = {};
  const progress = (f: number): void => onProgress?.(Math.min(1, Math.max(0, f)));
  let t0 = now();
  const lap = (key: string): void => {
    const t = now();
    timings[key] = (timings[key] ?? 0) + (t - t0);
    t0 = t;
  };

  const surf = prepareOutputSurface(input, params);
  const nx = params.fast ? gridTuning.fastNx : gridTuning.fullNx;
  const ny = params.fast ? gridTuning.fastNy : gridTuning.fullNy;
  const core = prepareCoreSurface(surf, nx, ny);
  const g = core.g;
  const M = makeEbmModel(g, core.land, core.height, params, gridTuning.stepsPerMonth);
  lap('dyn.input');

  // ---- Initial states. Pass 1 always starts from the steady/periodic initialization, so its
  //      circulation, currents and upwelling source temperature (T_sub, from the pass-1 SST) depend
  //      only on (input, params). A warm start seeds pass 2 only: seeding pass 1 with an
  //      already-coupled state made T_sub depend on the previous result, so repeated warm restarts
  //      drifted (colder upwelling water → colder SST → colder T_sub …) instead of converging to
  //      the cold-start climate.
  const cold = params.fast ? spinupTuning.fast : spinupTuning.full;
  const S1 = makeState(g.n);
  periodicInit(M, steadyAnnualMean(M), S1);
  let S = S1;
  let usedWarm = false;
  if (warm && warm.w > 0 && warm.h > 0) {
    const Sw = makeState(g.n);
    usedWarm = warmState(M, core, warm, Sw);
    if (usedWarm) S = Sw;
  }
  stats.warmStart = usedWarm ? 1 : 0;
  lap('dyn.init');
  progress(0.05);
  const pass2 = usedWarm ? (params.fast ? spinupTuning.warmFast : spinupTuning.warmFull) : cold;

  // ---- Pass 1: no currents.
  const mon1 = makeMonthly(g.n);
  spinYears(M, S1, NO_COUPLING, cold.pass1Years, cold.pass1Aitken, stats, 'pass1');
  integrateYear(M, S1, NO_COUPLING, mon1);
  // Land snow and ice always come from the cold pass 1 (deterministic in the input: glacier margins
  // are hysteretic, and a warm start from a previous result would carry its margins along); the
  // glacier topology is settled on pass-1 balances only and held afterwards (energyIce.ts).
  if (S !== S1) {
    S.M.set(S1.M);
    S.Ms.set(S1.Ms);
  }
  lap('dyn.pass1');
  progress(0.35);

  let circ = computeCirculation(g, mon1.tAir, core.land, core.landFraction, params);
  lap('dyn.circulation');
  const oceanCtx = makeOceanContext(g, core.landFraction, core.land, params.retrograde);
  let ocean = computeOcean(oceanCtx, circ.windU, circ.windV, null, params.fast, circ.baroclinic);
  lap('dyn.ocean');
  progress(0.5);

  // ---- Pass 2: air advection, mixed-layer advection and upwelling.
  const coupling = makeCoupling(M, core.land, circ, ocean, mon1, params);
  lap('dyn.stencils');
  const mon2 = makeMonthly(g.n);
  spinYears(M, S, coupling, pass2.pass2Years - 1, pass2.pass2Aitken, stats, 'pass2');
  integrateYear(M, S, coupling, mon2);
  lap('dyn.pass2');
  progress(0.85);

  // ---- Final circulation consistent with the output temperatures.
  circ = computeCirculation(g, mon2.tAir, core.land, core.landFraction, params);
  lap('dyn.circulation');
  ocean = computeOcean(oceanCtx, circ.windU, circ.windV, ocean, params.fast, circ.baroclinic);
  lap('dyn.ocean');
  for (const [k, v] of Object.entries(ocean.stats)) stats[`ocean.${k}`] = v;

  // Glacier cover from the held glacier topology (energyIce.ts), not from the output year's mass
  // minimum, which would let a strongly ablating margin flicker with the run's last-year weather.
  const glacierMass = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) glacierMass[i] = M.iceMask[i] ? ebmTuning.glacierMassMax : 0;
  const fields = assembleOutput(
    g,
    core.land,
    {
      tAir: mon2.tAir, sst: mon2.sst, ice: mon2.ice, pressure: circ.pressure, windU: circ.windU, windV: circ.windV,
      steerU: circ.steerU, steerV: circ.steerV, ascent: circ.ascent, baroclinic: circ.baroclinic,
      currentU: ocean.currentU, currentV: ocean.currentV, upwelling: ocean.upwelling, landMass: glacierMass, iceRaise: M.iceRaise,
    },
    surf,
    params.globalTempOffset,
  );
  lap('dyn.output');
  collectStats(g, mon2, core.land, stats);
  stats.coreNx = nx;
  stats.coreNy = ny;
  progress(1);
  return {
    w: surf.w,
    h: surf.h,
    params: { ...params },
    land: surf.land,
    landFraction: surf.landFraction,
    elev: surf.elev,
    surfaceHeight: surf.surfaceHeight,
    temp: fields.temp,
    sst: fields.sst,
    seaIce: fields.seaIce,
    pressure: fields.pressure,
    windU: fields.windU,
    windV: fields.windV,
    steerU: fields.steerU,
    steerV: fields.steerV,
    ascent: fields.ascent,
    baroclinic: fields.baroclinic,
    currentU: fields.currentU,
    currentV: fields.currentV,
    upwelling: fields.upwelling,
    landIce: fields.landIce,
    iceRaise: fields.iceRaise,
    timings,
    stats,
  };
}

/** Integrate `years` spin-up years; with `aitken` (and ≥ 2 years) extrapolate the drift. */
function spinYears(M: EbmModel, S: EbmState, cp: EbmCoupling, years: number, aitken: boolean, stats: Record<string, number>, key: string): void {
  if (years <= 0) return;
  let s0: EbmState | null = aitken && years >= 2 ? cloneState(S) : null;
  let s1: EbmState | null = null;
  for (let y = 0; y < years; y++) {
    integrateYear(M, S, cp, null);
    if (!s0) continue;
    if (!s1) s1 = cloneState(S);
    else {
      stats[`${key}.aitkenCells`] = aitkenExtrapolate(M, s0, s1, S);
      // Restart the Δ² sequence from the extrapolated state.
      s0 = cloneState(S);
      s1 = null;
    }
  }
}

export function makeCoupling(M: EbmModel, land: Uint8Array, circ: Circulation, ocean: OceanResult, mon1: EbmMonthly, params: ClimateParams): EbmCoupling {
  const t = ebmTuning;
  const g = M.g;
  const n = g.n;
  const air: SLStencil[] = [];
  const sea: SLStencil[] = [];
  const oceanScale = Math.max(0, params.oceanCurrents);
  for (let m = 0; m < 12; m++) {
    air.push(buildStencil(g, circ.heatU, circ.heatV, m * n, t.heatAdvectionFactor, M.dt, t.cellsPerSubstep, t.maxSubsteps));
    sea.push(buildStencil(g, ocean.currentU, ocean.currentV, m * n, t.sstAdvectionFactor * oceanScale, M.dt, t.cellsPerSubstep, t.maxSubsteps));
  }
  // Land coupling of advected air from the terrain rise dh along one air sub-step: cold air
  // cannot climb (exp(−dh⁺/H)), warm air is stable over colder land and descending warm air
  // overrides the lowland air (k_stable·exp(−dh⁻/H)).
  const airWarm = new Float32Array(12 * n);
  const airCold = new Float32Array(12 * n);
  const height = new Float64Array(n);
  for (let i = 0; i < n; i++) height[i] = M.lapse[i] / LAPSE_RATE;
  const hDep = new Float64Array(n);
  for (let m = 0; m < 12; m++) {
    applyStencil(air[m], height, hDep);
    for (let i = 0; i < n; i++) {
      const dh = height[i] - hDep[i];
      airWarm[m * n + i] = t.stableAdvectionFactor * Math.exp(Math.min(0, dh) / t.leeHeight);
      airCold[m * n + i] = Math.exp(-Math.max(0, dh) / t.leeHeight);
    }
  }
  const isOcean = new Uint8Array(n);
  for (let i = 0; i < n; i++) isOcean[i] = land[i] ? 0 : 1;
  const nearestOcean = nearestValidIndex(g.nx, g.ny, isOcean);
  const hasOcean = nearestOcean[0] >= 0;
  // Upwelling damping λ_u = ρc·w⁺·efficiency (W/m²/K) toward T_sub = zonal annual SST − ΔT.
  const upwellLambda = new Float64Array(12 * n);
  const k = t.rhoCpWater * t.upwellingEfficiency * oceanScale;
  for (let i = 0; i < 12 * n; i++) upwellLambda[i] = k * ocean.upwelling[i];
  const tSub = subsurfaceTemperature(g, land, mon1.sst, circ.windU, params.retrograde);
  // Cloud regimes of the circulation: clear skies under subsidence, bright storm tracks and
  // stratocumulus over cold water (dynCloud.ts).
  const albedoOffset = cloudAlbedoOffset(g, land, circ, mon1.sst, upwellLambda, tSub);
  return { air, airWarm, airCold, albedoOffset, sea: hasOcean ? sea : null, nearestOcean: hasOcean ? nearestOcean : null, upwellLambda, tSub };
}

function collectStats(g: EbmModel['g'], mon: EbmMonthly, land: Uint8Array, stats: Record<string, number>): void {
  const n = g.n;
  const ann = new Float64Array(n);
  const ice = new Float64Array(n);
  for (let m = 0; m < 12; m++) {
    for (let i = 0; i < n; i++) {
      ann[i] += mon.tAir[m * n + i] / 12;
      ice[i] += mon.ice[m * n + i] / 12;
    }
  }
  stats.coreGlobalMeanTsl = globalMean(g, ann);
  stats.coreSeaIceFraction = globalMean(g, ice);
  let landCells = 0;
  for (let i = 0; i < n; i++) landCells += land[i];
  stats.coreLandCells = landCells;
}
