/**
 * Monthly steady-state moisture balance (SPEC §6.2), solved by pseudo-time stepping. Each step:
 *
 *   1. transport:  W_adv = mass-fixed( SL-advect( diffuse(W) ) · exp(−dt ∇·u) )
 *   2. columns:    W ← (W_adv + dt·E) / (1 + dt·P/W) with the humidity-gated rate P/W, ocean
 *                  evaporation and land ET (moistureColumn.ts)
 *
 * Transport conserves Σ area·W (flux-form compression + global proportional fixer) and the column
 * update removes exactly dt·P, so at convergence Σ P = Σ E. Iterates until the largest relative
 * change of P over `checkEvery` steps drops below the tolerance.
 */
import type { HydroTuning } from './hydroTuning';
import { updateColumns } from './moistureColumn';
import type { ColumnContext } from './moistureColumn';
import type { ImplicitDiffusion } from './moistureDiffusion';
import type { MonthForcing } from './moistureForcing';
import type { HydroGrid } from './moistureGrid';
import type { Stencil } from './moistureStencil';

export interface MoistureState {
  /** Column water, kg/m². */
  W: Float64Array;
  /** Precipitation and evaporation, kg m⁻² s⁻¹ (P also feeds the land-ET fixed point). */
  P: Float64Array;
  E: Float64Array;
}

export interface MonthSolveStats {
  steps: number;
  converged: boolean;
  /** Last measured max relative change of P over one check interval. */
  residual: number;
  /** Mean |1 − mass-fixer factor| per step (transport non-conservation diagnostic). */
  fixerDrift: number;
}

export function allocMoistureState(n: number): MoistureState {
  return { W: new Float64Array(n), P: new Float64Array(n), E: new Float64Array(n) };
}

/** Workspace reused across months. */
export interface SolverScratch {
  adv: Float64Array;
  pCheck: Float64Array;
  /** Water held back by high terrain this step (kg/m² over the source cell). */
  blocked: Float64Array;
}

export function allocSolverScratch(n: number): SolverScratch {
  return { adv: new Float64Array(n), pCheck: new Float64Array(n), blocked: new Float64Array(n) };
}

/** Initialize W from column RH (land / ocean) for a cold start; P, E from a first sink evaluation. */
export function coldStartState(g: HydroGrid, f: MonthForcing, landFrac: Float64Array, t: HydroTuning, s: MoistureState): void {
  for (let i = 0; i < g.n; i++) {
    const lf = landFrac[i];
    const rh = t.initialRhOcean * (1 - lf) + t.initialRhLand * lf;
    s.W[i] = rh * f.wsat[i];
    s.P[i] = 0;
    s.E[i] = 0;
  }
}

/**
 * Iterate month `f` to convergence (or `maxSteps`), starting from the current state.
 * `diffusion` must already be set up for f.eddyK and dt; `stencil` holds the departure points
 * (with the compression factor folded into its weights). `lift` (4 per cell, optional) is the share
 * of each source's water that can follow the air onto higher terrain; the rest cannot climb the
 * barrier and stays in the source column (the blocked moist layer flows around), so transport still
 * conserves Σ area·W.
 */
export function solveMonth(
  g: HydroGrid,
  f: MonthForcing,
  stencil: Stencil,
  diffusion: ImplicitDiffusion,
  dt: number,
  t: HydroTuning,
  maxSteps: number,
  state: MoistureState,
  scratch: SolverScratch,
  lift: Float32Array | null = null,
): MonthSolveStats {
  const { n, w, h } = g;
  const { W, P, E } = state;
  const { adv, pCheck, blocked } = scratch;
  const { idx, wt } = stencil;
  const rowArea = g.rowArea;
  const floor = t.convergenceFloorMmDay / 86400;
  const checkEvery = Math.max(1, t.checkEvery);
  const minSteps = Math.max(checkEvery, t.minSteps);
  const column: ColumnContext = {
    wsat: f.wsat,
    invWsat: f.invWsat,
    mult: f.mult,
    evapA: f.evapA,
    evapB: f.evapB,
    etCap: f.etCap,
    etMemory: f.etMemory,
    pet: f.pet,
    substeps: f.substeps,
    gateR0: f.gateR0,
    a: t.gateSteepness,
    invTauP: 1 / (t.precipTimescaleDays * 86400),
    invTauC: 1 / (t.condensationTimescaleHours * 3600),
    dt,
  };

  let mass = 0;
  for (let r = 0; r < h; r++) {
    let s = 0;
    for (let c = 0; c < w; c++) s += W[r * w + c];
    mass += s * rowArea[r];
  }
  pCheck.set(P);
  let steps = 0;
  let residual = Infinity;
  let converged = false;
  let fixerDrift = 0;

  while (steps < maxSteps) {
    // 1. Transport: implicit eddy diffusion of W in place, then the semi-Lagrangian gather
    //    (compression folded into the weights) and the global proportional mass fixer, so
    //    transport alone neither creates nor destroys water.
    diffusion.apply(W);
    let advMass = 0;
    if (lift) blocked.fill(0);
    for (let r = 0; r < h; r++) {
      let rowAdv = 0;
      const ra = rowArea[r];
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        const k = 4 * i;
        let v: number;
        if (lift && (lift[k] < 1 || lift[k + 1] < 1 || lift[k + 2] < 1 || lift[k + 3] < 1)) {
          v = 0;
          for (let q = 0; q < 4; q++) {
            const j = idx[k + q];
            const x = wt[k + q] * W[j];
            const f = lift[k + q];
            v += f * x;
            // Held back below the barrier top: stays with the source (per unit area of j).
            if (f < 1 && x > 0) blocked[j] += ((1 - f) * x * ra) / rowArea[(j / w) | 0];
          }
        } else v = wt[k] * W[idx[k]] + wt[k + 1] * W[idx[k + 1]] + wt[k + 2] * W[idx[k + 2]] + wt[k + 3] * W[idx[k + 3]];
        if (v < 0) v = 0;
        adv[i] = v;
        rowAdv += v;
      }
      advMass += rowAdv * ra;
    }
    if (lift) {
      for (let r = 0; r < h; r++) {
        let rowB = 0;
        for (let c = 0; c < w; c++) {
          const i = r * w + c;
          const b = blocked[i];
          if (b > 0) {
            adv[i] += b;
            rowB += b;
          }
        }
        advMass += rowB * rowArea[r];
      }
    }
    const fix = advMass > 0 ? mass / advMass : 1;
    fixerDrift += Math.abs(1 - fix);
    // 2. Column physics: sources and implicit sink.
    mass = updateColumns(column, adv, fix, W, P, E, w, rowArea);
    steps++;

    if (steps % checkEvery === 0) {
      let worst = 0;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(P[i] - pCheck[i]) / (pCheck[i] + floor);
        if (d > worst) worst = d;
      }
      pCheck.set(P);
      residual = worst;
      if (steps >= minSteps && worst < t.convergenceTolerance) {
        converged = true;
        break;
      }
    }
  }
  return { steps, converged, residual, fixerDrift: steps > 0 ? fixerDrift / steps : 0 };
}
