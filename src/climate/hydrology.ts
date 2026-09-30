import type { DynamicsResult, HydrologyResult } from './internal';
import { solveAnnualCycle } from './hydroAnnual';
import type { MoistureSolution, MonthlyInit } from './hydroAnnual';
import { computeCloudCover } from './hydroCloud';
import { canNest, downMonthly, downsampleDynamics, upsampleMonthly } from './hydroNest';
import { computeSnowCover } from './hydroSnow';
import { resolveHydroTuning } from './hydroTuning';
import type { HydroTuning } from './hydroTuning';
import { rmsAllMonths } from './moistureForcing';
import { globalMean, makeHydroGrid } from './moistureGrid';

const now = (): number => globalThis.performance?.now?.() ?? Date.now();

function checkInput(dyn: DynamicsResult): void {
  const n = dyn.w * dyn.h;
  const fixed: Array<[string, ArrayLike<number>]> = [
    ['land', dyn.land],
    ['landFraction', dyn.landFraction],
    ['surfaceHeight', dyn.surfaceHeight],
  ];
  const monthly: Array<[string, ArrayLike<number>]> = [
    ['temp', dyn.temp],
    ['sst', dyn.sst],
    ['seaIce', dyn.seaIce],
    ['windU', dyn.windU],
    ['windV', dyn.windV],
    ['steerU', dyn.steerU],
    ['steerV', dyn.steerV],
    ['ascent', dyn.ascent],
    ['baroclinic', dyn.baroclinic],
  ];
  for (const [name, a] of fixed) {
    if (a.length !== n) throw new Error(`computeHydrology: dyn.${name} has length ${a.length}, expected ${n}`);
  }
  for (const [name, a] of monthly) {
    if (a.length !== 12 * n) throw new Error(`computeHydrology: dyn.${name} has length ${a.length}, expected ${12 * n}`);
  }
  // DynamicsResult promises finite fields; one NaN would otherwise spread through transport and
  // surface only as a non-finite output far from its cause.
  for (const [name, a] of [...fixed, ...monthly]) {
    for (let k = 0; k < a.length; k++) {
      if (!Number.isFinite(a[k])) throw new Error(`computeHydrology: dyn.${name}[${k}] is not finite (${a[k]})`);
    }
  }
  for (const key of ['moisture', 'axialTilt'] as const) {
    if (!Number.isFinite(dyn.params[key])) throw new Error(`computeHydrology: params.${key} is not finite`);
  }
}

/**
 * Warm start from a previous result on the same grid (ignored when the grid differs). On grids that
 * nest it seeds the coarse level (see solveWithNesting).
 */
function warmStartInit(warm: HydrologyResult | null | undefined, n: number): MonthlyInit | null {
  if (!warm || warm.rh.length !== 12 * n || warm.precip.length !== 12 * n) return null;
  for (let k = 0; k < 12 * n; k++) {
    if (!Number.isFinite(warm.rh[k]) || !Number.isFinite(warm.precip[k])) {
      throw new Error('computeHydrology: warm start contains non-finite values');
    }
  }
  return { rh: warm.rh, precip: warm.precip };
}

/** Result of a (possibly nested) solve. */
interface SolveOutcome {
  sol: MoistureSolution;
  /** Months meeting the convergence criterion, and the largest final residual, at the level where
   *  the criterion was applied (the coarsest level of a nested solve). */
  monthsConverged: number;
  maxResidual: number;
  coarseSteps: number;
}

/**
 * Large grids solve a half-resolution copy first (recursively, hydroNest.ts) and relax the
 * interpolated result for a bounded number of steps per month; small grids solve directly with the
 * convergence criterion. A warm start seeds the coarsest level (box-averaged): seeding the full
 * grid directly made a poor warm start (another world, a changed parameter) cost up to 80 fine
 * steps per month — slower than a cold start and over the SPEC §6.2 budget (≈ 2.7 s at 360×180,
 * 0.46 s fast at 180×90) — and gave results that depended on the seed's convergence history.
 */
function solveWithNesting(
  dyn: DynamicsResult,
  t: HydroTuning,
  init: MonthlyInit | null,
  timings: Record<string, number>,
  onProgress?: (fraction: number) => void,
): SolveOutcome {
  const fast = dyn.params.fast;
  if (!canNest(dyn.w, dyn.h, fast ? t.nestMinWidthFast : t.nestMinWidth)) {
    const sol = solveAnnualCycle(dyn, t, init, null, timings, onProgress);
    return { sol, monthsConverged: sol.monthsConverged, maxResidual: sol.maxResidual, coarseSteps: 0 };
  }
  const tc = now();
  const coarseDyn = downsampleDynamics(dyn);
  const cw = coarseDyn.w;
  const ch = coarseDyn.h;
  const coarseInit: MonthlyInit | null = init
    ? { rh: downMonthly(init.rh, dyn.w, dyn.h, cw, ch), precip: downMonthly(init.precip, dyn.w, dyn.h, cw, ch) }
    : null;
  const coarse = solveWithNesting(coarseDyn, t, coarseInit, {}, (f) => onProgress?.(0.6 * f));
  const fineInit: MonthlyInit = {
    rh: upsampleMonthly(coarse.sol.rh, cw, ch, dyn.w, dyn.h),
    precip: upsampleMonthly(coarse.sol.precip, cw, ch, dyn.w, dyn.h),
  };
  timings.hydroCoarse = (timings.hydroCoarse ?? 0) + now() - tc;
  const fineSteps = fast ? t.nestFineStepsFast : t.nestFineSteps;
  const sol = solveAnnualCycle(dyn, t, fineInit, fineSteps, timings, (f) => onProgress?.(0.6 + 0.4 * f));
  return {
    sol,
    monthsConverged: coarse.monthsConverged,
    maxResidual: coarse.maxResidual,
    coarseSteps: coarse.coarseSteps + coarse.sol.steps,
  };
}

/** Area-weighted annual totals (mm/yr): global P and E, and P over the model's land cells. */
function waterBudget(dyn: DynamicsResult, sol: MoistureSolution): { precip: number; evap: number; landPrecip: number } {
  const { w, h } = dyn;
  const n = w * h;
  const g = makeHydroGrid(w, h);
  let precip = 0;
  let evap = 0;
  for (let m = 0; m < 12; m++) {
    precip += globalMean(g, sol.precip, m * n);
    evap += globalMean(g, sol.evap, m * n);
  }
  let landP = 0;
  let landArea = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (!dyn.land[i]) continue;
      let s = 0;
      for (let m = 0; m < 12; m++) s += sol.precip[m * n + i];
      landP += s * g.rowArea[r];
      landArea += g.rowArea[r];
    }
  }
  return { precip, evap, landPrecip: landArea > 0 ? landP / landArea : 0 };
}

function assertFinite(name: string, a: Float32Array): void {
  for (let k = 0; k < a.length; k++) {
    if (!Number.isFinite(a[k])) throw new Error(`computeHydrology: non-finite ${name} at index ${k}`);
  }
}

/**
 * Moisture transport and precipitation (SPEC.md §6.2): column water advected by the steering wind,
 * ocean evaporation, land ET recycling, humidity-gated precipitation with ascent / baroclinic /
 * orographic / stability modifiers applied as an implicit sink, eddy diffusion, snowpack, clouds.
 * `warmStart` (previous result on the same grid) seeds the iteration.
 * `tuning` optionally overrides constants of hydroTuning.ts (calibration).
 */
export function computeHydrology(
  dyn: DynamicsResult,
  warmStart?: HydrologyResult | null,
  onProgress?: (fraction: number) => void,
  tuning?: Partial<HydroTuning>,
): HydrologyResult {
  const tStart = now();
  const t = resolveHydroTuning(tuning);
  checkInput(dyn);
  const n = dyn.w * dyn.h;
  const timings: Record<string, number> = {};

  const init = warmStartInit(warmStart, n);
  const outcome = solveWithNesting(dyn, t, init, timings, (f) => onProgress?.(0.95 * f));
  const { sol } = outcome;

  const tPost = now();
  const snow = new Float32Array(12 * n);
  computeSnowCover({ n, temp: dyn.temp, precip: sol.precip, land: dyn.land, seaIce: dyn.seaIce }, t, snow);
  const cloud = new Float32Array(12 * n);
  // Normalized ascent / storm-track index (as in the precipitation multiplier) for the cloud regimes.
  const hg = makeHydroGrid(dyn.w, dyn.h);
  const aRms = rmsAllMonths(hg, dyn.ascent) * t.ascentRmsScale;
  const bRms = rmsAllMonths(hg, dyn.baroclinic) * t.baroclinicRmsScale;
  const ascN = new Float32Array(12 * n);
  const stormN = new Float32Array(12 * n);
  for (let k = 0; k < 12 * n; k++) {
    ascN[k] = aRms > 1e-30 ? dyn.ascent[k] / aRms : 0;
    stormN[k] = bRms > 1e-30 ? Math.max(0, dyn.baroclinic[k] / bRms) : 0;
  }
  computeCloudCover(
    { n, rh: sol.rh, precip: sol.precip, stab: sol.stab, landFraction: dyn.landFraction, seaIce: dyn.seaIce, ascent: ascN, storm: stormN, temp: dyn.temp },
    t,
    cloud,
  );
  timings.hydroPost = now() - tPost;

  for (const [name, a] of [['precip', sol.precip], ['evap', sol.evap], ['rh', sol.rh], ['snow', snow], ['cloud', cloud]] as const) {
    assertFinite(name, a);
  }
  const budget = waterBudget(dyn, sol);
  timings.hydroTotal = now() - tStart;
  onProgress?.(1);
  return {
    precip: sol.precip,
    evap: sol.evap,
    snow,
    cloud,
    rh: sol.rh,
    timings,
    stats: {
      globalPrecipMmYr: budget.precip,
      globalEvapMmYr: budget.evap,
      /** Global |P − E| / E (SPEC §6.2 target < 5%). */
      waterBalanceError: budget.evap > 0 ? Math.abs(budget.precip - budget.evap) / budget.evap : 0,
      landPrecipMmYr: budget.landPrecip,
      hydroSteps: sol.steps,
      hydroCoarseSteps: outcome.coarseSteps,
      hydroMonthsConverged: outcome.monthsConverged,
      hydroMaxResidual: outcome.maxResidual,
      /** Last convergence residual on the output grid (after a nested solve: of its bounded relaxation). */
      hydroFineMaxResidual: sol.maxResidual,
      hydroFixerDrift: sol.fixerDrift,
    },
  };
}
