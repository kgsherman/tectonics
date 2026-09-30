/**
 * Run the climate model on the Earth validation input and compute its metrics. Shared by
 * scripts/earth.ts (report + images) and scripts/calibrate.ts (parameter sweeps, in-process).
 */
import { buildEarthClimateInput } from '../../src/climate/earthInput';
import type { ClimateInput, ClimateParams, ClimateResult } from '../../src/core/types';
import { computeEarthMetrics, type EarthMetrics } from './earthMetrics';
import { runStage, type StageLog } from './stage';

export interface EarthRunOptions {
  w: number;
  h: number;
  fast: boolean;
  /** Extra ClimateParams overrides (e.g. axialTilt for experiments). */
  params?: Partial<ClimateParams>;
  verbose?: boolean;
}

export interface EarthRun {
  input: ClimateInput;
  result: ClimateResult | null;
  metrics: EarthMetrics | null;
  stages: StageLog;
  climateMs: number;
}

const earthInputs = new Map<string, ClimateInput>();

export async function runEarthClimate(opts: EarthRunOptions): Promise<EarthRun> {
  const verbose = opts.verbose ?? true;
  const stages: StageLog = {};
  const key = `${opts.w}x${opts.h}`;
  let input = earthInputs.get(key);
  if (!input) {
    input = (await runStage(stages, 'earthInput', () => buildEarthClimateInput(opts.w, opts.h), undefined, verbose))!;
    if (!input) throw new Error(`buildEarthClimateInput failed: ${stages.earthInput?.message}`);
    earthInputs.set(key, input);
  }
  const climate = await runStage(stages, 'loadClimateModule', () => import('../../src/climate/climate'), undefined, verbose);
  let result: ClimateResult | null = null;
  if (climate) {
    const params: ClimateParams = {
      ...climate.DEFAULT_CLIMATE_PARAMS, gridW: opts.w, gridH: opts.h, fast: opts.fast, ...opts.params,
    };
    // Fresh copy: the model must not be able to mutate the cached input between runs.
    const fresh: ClimateInput = { ...input, elev: input.elev.slice(), landFraction: input.landFraction?.slice() };
    result = (await runStage(stages, 'computeClimate', () => climate.computeClimate(fresh, params), undefined, verbose)) ?? null;
  }
  const metrics = result ? ((await runStage(stages, 'metrics', () => computeEarthMetrics(result!), undefined, verbose)) ?? null) : null;
  return { input, result, metrics, stages, climateMs: stages.computeClimate?.ms ?? 0 };
}
