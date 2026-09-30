/**
 * Annual cycle of the moisture solver (SPEC §6.2): per month the forcing, departure stencils and
 * diffusion factors are rebuilt and the steady monthly balance is iterated (moistureSolver.ts).
 *
 * Month sequencing / warm starts:
 *  - with a previous result on the same grid, every month starts from its own previous state;
 *  - otherwise month 0 starts cold and month m starts from month m−1's column relative humidity
 *    (more persistent than W across a seasonal temperature change); after the lap the first
 *    `wrapMonths` months are re-solved from their own lap solution so their soil memory (below)
 *    sees the previous December.
 *
 * Soil-moisture memory for land ET: ET = min(PET, β·((1 − μ)·P + μ·H)) where H is an exponential
 * moving average of earlier months' precipitation.
 */
import { SECONDS_PER_MONTH } from '../core/constants';
import type { DynamicsResult } from './internal';
import type { HydroTuning } from './hydroTuning';
import { ImplicitDiffusion } from './moistureDiffusion';
import { allocForcingScratch, allocMonthForcing, computeMonthForcing, computeStaticForcing } from './moistureForcing';
import { makeHydroGrid } from './moistureGrid';
import type { HydroGrid } from './moistureGrid';
import { allocMoistureState, allocSolverScratch, coldStartState, solveMonth } from './moistureSolver';
import { allocStencil, buildDepartureStencil } from './moistureStencil';

const now = (): number => globalThis.performance?.now?.() ?? Date.now();

/** Monthly moisture solution (12*n arrays) before the snow / cloud diagnostics. */
export interface MoistureSolution {
  /** mm/month. */
  precip: Float32Array;
  evap: Float32Array;
  /** Column relative humidity W / W_sat. */
  rh: Float32Array;
  /** Cold-SST stability seen by each cell (K), for stratocumulus. */
  stab: Float32Array;
  /** Condensation reference of each cell for clouds (the humidity-gate threshold without its storm-track shift). */
  gateR0: Float32Array;
  /** Pseudo-time steps in total (including wrap-around re-solves). */
  steps: number;
  monthsConverged: number;
  /** Largest final convergence residual over the months. */
  maxResidual: number;
  /** Mean |1 − mass-fixer factor| per step. */
  fixerDrift: number;
}

/** Previous result used to seed every month. */
export interface MonthlyInit {
  /** 12*n column RH and precipitation (mm/month). */
  rh: Float32Array;
  precip: Float32Array;
}

type StartMode = 'cold' | 'carry' | 'warm' | 'resolve';

/** Pseudo-time step (s): ∝ grid spacing so the per-step displacement in cells stays similar. */
function pseudoTimeStep(g: HydroGrid, t: HydroTuning): number {
  const degrees = 360 / g.w;
  const hours = Math.min(t.dtHoursMax, Math.max(t.dtHoursMin, t.dtHoursPerDegree * degrees));
  return hours * 3600;
}

/**
 * Solve all 12 months on the grid of `dyn`. `stepsPerMonth` (optional) replaces the per-month step
 * caps (used for the bounded fine relaxation after a nested coarse solve).
 */
export function solveAnnualCycle(
  dyn: DynamicsResult,
  t: HydroTuning,
  init: MonthlyInit | null,
  stepsPerMonth: number | null,
  timings: Record<string, number>,
  onProgress?: (fraction: number) => void,
): MoistureSolution {
  const g = makeHydroGrid(dyn.w, dyn.h);
  const n = g.n;
  let t0 = now();
  const st = computeStaticForcing(g, dyn, t);
  timings.hydroStatic = (timings.hydroStatic ?? 0) + now() - t0;
  const dt = pseudoTimeStep(g, t);
  const forcing = allocMonthForcing(n);
  const fScratch = allocForcingScratch(g);
  const stencil = allocStencil(n);
  const diffusion = new ImplicitDiffusion(g);
  const state = allocMoistureState(n);
  const sScratch = allocSolverScratch(n);
  const out: MoistureSolution = {
    precip: new Float32Array(12 * n),
    evap: new Float32Array(12 * n),
    rh: new Float32Array(12 * n),
    stab: new Float32Array(12 * n),
    gateR0: new Float32Array(12 * n),
    steps: 0,
    monthsConverged: 0,
    maxResidual: 0,
    fixerDrift: 0,
  };
  const converged = new Uint8Array(12);
  const residual = new Float64Array(12);

  // Soil memory H (kg m⁻² s⁻¹) of earlier months' precipitation, and its decay per month.
  const memory = new Float64Array(n);
  const keepMemory = Math.exp(-1 / Math.max(1e-6, t.etMemoryMonths));
  let memoryValid = false;
  if (init) {
    // Previous year's cycle: two laps of the moving average end at "after December".
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let m = 0; m < 12; m++) s += init.precip[m * n + i];
      memory[i] = Math.max(0, s / 12) / SECONDS_PER_MONTH;
    }
    for (let lap = 0; lap < 2; lap++) {
      for (let m = 0; m < 12; m++) {
        for (let i = 0; i < n; i++) {
          memory[i] = keepMemory * memory[i] + ((1 - keepMemory) * Math.max(0, init.precip[m * n + i])) / SECONDS_PER_MONTH;
        }
      }
    }
    memoryValid = true;
  }

  const lastRh = new Float64Array(n);
  const wrap = init ? 0 : Math.max(0, Math.min(12, Math.round(t.wrapMonths)));
  const totalSolves = 12 + wrap;
  let solves = 0;
  let tForcing = 0;
  let tSolve = 0;
  let fixerSum = 0;

  const runMonth = (m: number, mode: StartMode): void => {
    const off = m * n;
    t0 = now();
    computeMonthForcing(g, dyn, st, m, dt, t, fScratch, forcing);
    const beta = t.etRecycling;
    const mu = memoryValid ? t.etMemoryWeight : 0;
    for (let i = 0; i < n; i++) {
      const lf = st.landFrac[i];
      forcing.etCap[i] = beta * (1 - mu) * lf;
      forcing.etMemory[i] = beta * mu * lf * memory[i];
    }
    buildDepartureStencil(g, dyn.steerU, dyn.steerV, off, dt, t.departureIterations, stencil, forcing.compression);
    diffusion.setup(forcing.eddyK, dt, t.diffusionBlockHeight > 0 ? st.hSmooth : null, t.diffusionBlockHeight);
    tForcing += now() - t0;

    t0 = now();
    let maxSteps = t.maxStepsWarm;
    if (mode === 'cold') {
      coldStartState(g, forcing, st.landFrac, t, state);
      maxSteps = t.maxStepsCold;
    } else if (mode === 'carry') {
      for (let i = 0; i < n; i++) state.W[i] = lastRh[i] * forcing.wsat[i];
    } else {
      const src = mode === 'warm' && init ? init : out;
      for (let i = 0; i < n; i++) {
        state.W[i] = src.rh[off + i] * forcing.wsat[i];
        state.P[i] = Math.max(0, src.precip[off + i]) / SECONDS_PER_MONTH;
      }
    }
    if (!(dyn.params.moisture > 0)) {
      // No evaporation: the balance is the dry column. Starting from it avoids raining out the
      // initial / warm-start water over the gate's very long low-RH time scales, and the soil
      // memory of a warm start's precipitation must not evaporate into it either.
      state.W.fill(0);
      state.P.fill(0);
      forcing.etMemory.fill(0);
    }
    if (stepsPerMonth !== null) maxSteps = stepsPerMonth;
    if (dyn.params.fast) maxSteps = Math.min(maxSteps, t.maxStepsFast);
    const res = solveMonth(g, forcing, stencil, diffusion, dt, t, maxSteps, state, sScratch);
    tSolve += now() - t0;
    out.steps += res.steps;
    fixerSum += res.fixerDrift * res.steps;
    converged[m] = res.converged ? 1 : 0;
    residual[m] = res.residual;

    for (let i = 0; i < n; i++) {
      const rh = state.W[i] * forcing.invWsat[i];
      lastRh[i] = rh;
      out.rh[off + i] = rh;
      out.precip[off + i] = state.P[i] * SECONDS_PER_MONTH;
      out.evap[off + i] = state.E[i] * SECONDS_PER_MONTH;
      out.stab[off + i] = forcing.stab[i];
      out.gateR0[off + i] = forcing.cloudR0[i];
      memory[i] = keepMemory * memory[i] + (1 - keepMemory) * state.P[i];
    }
    if (!memoryValid) {
      // First cold month: its own precipitation stands in for the unknown earlier months.
      for (let i = 0; i < n; i++) memory[i] = state.P[i];
      memoryValid = true;
    }
    solves++;
    onProgress?.(solves / totalSolves);
  };

  for (let m = 0; m < 12; m++) runMonth(m, init ? 'warm' : m === 0 ? 'cold' : 'carry');
  for (let m = 0; m < wrap; m++) runMonth(m, 'resolve');

  for (let m = 0; m < 12; m++) {
    out.monthsConverged += converged[m];
    if (residual[m] > out.maxResidual) out.maxResidual = residual[m];
  }
  out.fixerDrift = out.steps > 0 ? fixerSum / out.steps : 0;
  timings.hydroForcing = (timings.hydroForcing ?? 0) + tForcing;
  timings.hydroSolve = (timings.hydroSolve ?? 0) + tSolve;
  return out;
}
