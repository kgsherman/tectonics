/**
 * Headless world pipeline (SPEC §11): mesh → generate → simulate → climate → paint → PNGs + stats.
 *
 * Every stage that depends on another module is loaded with a dynamic import and run through
 * runStage, so the pipeline keeps going (and says so in stats.json) while modules are stubs:
 *  - generate fails  → synthetic fixture world (tests/helpers/fixtures)
 *  - simulate fails  → the unsimulated draft (snapshotFromDraft)
 *  - climate input   → headless land-aware supersampling (fallbackInput.ts)
 *  - computeClimate  → no climate (climate layers skipped)
 *  - paintLayer      → reference renderers (worldImages.ts / climateImages.ts)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KOPPEN_CLASSES } from '../../src/climate/koppen';
import { createSphereMesh } from '../../src/core/sphereMesh';
import type {
  ClimateParams, ClimateResult, GenerateParams, LayerId, SphereMesh, TectonicStats, WorldDraft, WorldSnapshot,
} from '../../src/core/types';
import { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM, CRUST_CONTINENTAL } from '../../src/core/types';
import { draftFromSnapshot, snapshotFromDraft } from '../../src/tectonics/draft';
import { syntheticSnapshot } from '../../tests/helpers/fixtures';
import { writePng } from '../png';
import { climateInputFallback } from './fallbackInput';
import { areaMean, rowAreaWeights } from './gridUtil';
import { runStage, skipStage, type StageLog } from './stage';
import { renderFallbackLayer } from './worldImages';

export const ALL_LAYERS: readonly LayerId[] = [
  'satellite', 'elevation', 'plates', 'crust', 'crustAge', 'temperature', 'precipitation', 'pressure', 'sst', 'wind', 'currents', 'koppen',
];

export interface HeadlessOptions {
  seed: number;
  /** Mesh cells. */
  n: number;
  /** Simulated time (Myr). */
  myr: number;
  out: string;
  layers: LayerId[];
  width: number;
  height: number;
  /** 0..11 or −1 (annual). */
  month: number;
  climate: 'full' | 'fast' | 'none';
  climateW: number;
  climateH: number;
  plates: number;
  continents: number;
  mode: GenerateParams['continentMode'];
  quality: 'full' | 'preview';
  seaLevel: number;
  overlay: boolean;
  verbose: boolean;
}

export const DEFAULT_HEADLESS_OPTIONS: HeadlessOptions = {
  seed: 1, n: 40_000, myr: 100, out: 'out/headless', layers: ['satellite', 'elevation', 'plates', 'koppen'],
  width: 1024, height: 512, month: -1, climate: 'fast', climateW: 360, climateH: 180, plates: 12, continents: 0.35,
  mode: 'scattered', quality: 'full', seaLevel: 0, overlay: true, verbose: true,
};

export interface ElevationStats {
  min: number; max: number; mean: number; p01: number; p05: number; p50: number; p95: number; p99: number;
  landMean: number; oceanMean: number;
}

export interface HeadlessStats {
  options: HeadlessOptions;
  stages: StageLog;
  /** Wall-clock per stage (ms), flattened from `stages`, plus `total`. */
  timings: Record<string, number>;
  totalMs: number;
  world: {
    /** Where the starting world came from, and whether the tectonic simulation ran on it. */
    origin: 'generated' | 'synthetic';
    simulated: boolean;
    n: number; time: number; plateCount: number; landFraction: number; continentalFraction: number;
    elevation: ElevationStats; boundaryCells: { convergent: number; divergent: number; transform: number };
    sim: TectonicStats | null;
  } | null;
  climate: {
    w: number; h: number; globalMeanTemp: number; globalPrecip: number; landFraction: number;
    koppenGroupAreas: Record<string, number>; koppenClassAreas: Record<string, number>;
    timings: Record<string, number>; stats: Record<string, number>;
  } | null;
  /** Per layer: who rendered it and the PNG file name (relative to options.out). */
  layers: Record<string, { renderer: 'paintLayer' | 'fallback' | 'none'; file?: string; note?: string }>;
}

const now = (): number => globalThis.performance?.now?.() ?? Date.now();

export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessStats> {
  const t0 = now();
  const log: StageLog = {};
  const v = opts.verbose;
  const say = (s: string): void => {
    if (v) console.log(s);
  };
  mkdirSync(opts.out, { recursive: true });
  const stats: HeadlessStats = { options: opts, stages: log, timings: {}, totalMs: 0, world: null, climate: null, layers: {} };

  // ---------------- world ----------------
  say(`worldgen headless: seed ${opts.seed}, n ${opts.n}, ${opts.myr} Myr`);
  const mesh = (await runStage(log, 'mesh', () => createSphereMesh(opts.n), undefined, v))!;
  if (!mesh) throw new Error('createSphereMesh failed');

  let origin: 'generated' | 'synthetic' = 'generated';
  const draft = await runStage<WorldDraft>(
    log, 'generate',
    async () => {
      const gen = await import('../../src/tectonics/generate');
      return gen.generateRandomDraft(mesh, {
        ...gen.DEFAULT_GENERATE_PARAMS, seed: opts.seed, plateCount: opts.plates, continentalFraction: opts.continents, continentMode: opts.mode,
      });
    },
    {
      label: 'synthetic fixture world (tests/helpers/fixtures.syntheticSnapshot)',
      run: () => {
        origin = 'synthetic';
        return draftFromSnapshot(syntheticSnapshot(mesh, opts.seed, opts.plates), opts.seed);
      },
    },
    v,
  );

  let snapshot: WorldSnapshot | null = null;
  let simStats: TectonicStats | null = null;
  if (draft) {
    if (opts.myr > 0) {
      const simulated = await runStage(log, 'simulate', () => simulate(mesh, draft, opts, say), undefined, v);
      if (simulated) {
        snapshot = simulated.snapshot;
        simStats = simulated.stats;
      }
    } else skipStage(log, 'simulate', '--myr 0', v);
    if (!snapshot) {
      snapshot = (await runStage(log, 'snapshotFromDraft', () => snapshotFromDraft(mesh, draft), undefined, v)) ?? null;
    }
  }
  if (snapshot) stats.world = { origin, simulated: simStats !== null, ...worldStats(snapshot, opts.seaLevel), sim: simStats };

  // ---------------- climate ----------------
  let climate: ClimateResult | null = null;
  if (opts.climate === 'none') skipStage(log, 'climate', '--climate none', v);
  else if (!snapshot) skipStage(log, 'climate', 'no world snapshot', v);
  else {
    const mod = await runStage(log, 'loadClimateModule', () => import('../../src/climate/climate'), undefined, v);
    if (mod) {
      const params: ClimateParams = {
        ...mod.DEFAULT_CLIMATE_PARAMS, gridW: opts.climateW, gridH: opts.climateH, seaLevel: opts.seaLevel, fast: opts.climate === 'fast',
      };
      const snap = snapshot;
      const input = await runStage(log, 'climateInput', () => mod.climateInputFromSnapshot(mesh, snap, params), {
        label: 'headless land-aware supersampling',
        run: () => climateInputFallback(mesh, snap, params.gridW, params.gridH, params.seaLevel),
      }, v);
      if (input) {
        climate = (await runStage(log, 'computeClimate', () => mod.computeClimate(input, params, undefined, null), undefined, v)) ?? null;
      }
    }
    if (climate) stats.climate = climateStats(climate);
  }

  // ---------------- paint ----------------
  const paint = await runStage(log, 'loadPainter', () => import('../../src/render/paint'), undefined, v);
  const cache = paint ? await runStage(log, 'paintCache', () => new paint.PaintCache(), undefined, v) : undefined;
  const sources = { mesh, snapshot, climate };
  const paintOpts = {
    width: opts.width, height: opts.height, month: opts.month, seaLevel: opts.seaLevel, hillshade: true,
    seed: opts.seed, quality: opts.quality,
  };
  for (const layer of opts.layers) {
    const name = `${layer}.png`;
    const file = join(opts.out, name);
    const res = paint
      ? await runStage(log, `paint:${layer}`, () => paint.paintLayer(layer, sources, paintOpts, cache), undefined, v)
      : undefined;
    if (res) {
      writePng(file, { width: res.width, height: res.height, rgba: res.rgba });
      stats.layers[layer] = { renderer: 'paintLayer', file: name };
      continue;
    }
    const fb = renderFallbackLayer(layer, mesh, snapshot, climate, opts.width, opts.height, opts.month, opts.seaLevel);
    if (fb) {
      writePng(file, fb.image);
      stats.layers[layer] = { renderer: 'fallback', file: name, note: fb.label };
      say(`  ${layer}: reference renderer (${fb.label})`);
    } else {
      stats.layers[layer] = { renderer: 'none', note: climate ? 'layer unsupported without painter' : 'needs climate' };
      say(`  ${layer}: not rendered (${stats.layers[layer].note})`);
    }
  }
  if (opts.overlay && paint) {
    const ov = await runStage(log, 'paint:overlay', () => paint.paintOverlay({ boundaries: true, graticule: true, coastlines: true }, sources, paintOpts, cache), undefined, v);
    if (ov) writePng(join(opts.out, 'overlay.png'), { width: opts.width, height: opts.height, rgba: ov });
  }

  stats.totalMs = now() - t0;
  for (const [name, st] of Object.entries(log)) stats.timings[name] = Math.round(st.ms * 10) / 10;
  stats.timings.total = Math.round(stats.totalMs);
  writeFileSync(join(opts.out, 'stats.json'), JSON.stringify(stats, null, 2));
  say(`done in ${(stats.totalMs / 1000).toFixed(1)} s → ${opts.out}`);
  return stats;
}

async function simulate(
  mesh: SphereMesh, draft: WorldDraft, opts: HeadlessOptions, say: (s: string) => void,
): Promise<{ snapshot: WorldSnapshot; stats: TectonicStats }> {
  const { TectonicSim } = await import('../../src/tectonics/sim');
  const sim = new TectonicSim(mesh, draft, { seed: opts.seed });
  const steps = Math.max(0, Math.round(opts.myr / sim.params.dt));
  const chunk = Math.max(1, Math.round(steps / 10));
  for (let done = 0; done < steps; ) {
    const k = Math.min(chunk, steps - done);
    const t = now();
    sim.step(k);
    done += k;
    say(`    t = ${sim.time.toFixed(0)} Myr (${((now() - t) / k).toFixed(0)} ms/step)`);
  }
  return { snapshot: sim.snapshot(), stats: sim.stats() };
}

function percentile(sorted: Float32Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/** World summary; Fibonacci cells are equal-area, so plain cell fractions are area fractions. */
export function worldStats(s: WorldSnapshot, seaLevel: number) {
  const n = s.n;
  let land = 0, cont = 0, sum = 0, sLand = 0, sSea = 0;
  const bc = { convergent: 0, divergent: 0, transform: 0 };
  for (let i = 0; i < n; i++) {
    const e = s.elev[i];
    sum += e;
    if (e > seaLevel) {
      land++;
      sLand += e;
    } else sSea += e;
    if (s.crust[i] === CRUST_CONTINENTAL) cont++;
    if (s.boundary[i] === BOUNDARY_CONVERGENT) bc.convergent++;
    else if (s.boundary[i] === BOUNDARY_DIVERGENT) bc.divergent++;
    else if (s.boundary[i] === BOUNDARY_TRANSFORM) bc.transform++;
  }
  const sorted = Float32Array.from(s.elev).sort();
  const elevation: ElevationStats = {
    min: sorted[0], max: sorted[n - 1], mean: sum / n,
    p01: percentile(sorted, 0.01), p05: percentile(sorted, 0.05), p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99),
    landMean: land > 0 ? sLand / land : 0, oceanMean: n - land > 0 ? sSea / (n - land) : 0,
  };
  return {
    n, time: s.time, plateCount: s.plates.length, landFraction: land / n, continentalFraction: cont / n,
    elevation, boundaryCells: bc,
  };
}

/** Climate summary: global means and Köppen areas (% of land area, cos-latitude weighted). */
export function climateStats(c: ClimateResult): NonNullable<HeadlessStats['climate']> {
  const { w, h } = c;
  const aw = rowAreaWeights(h);
  const cls = new Float64Array(KOPPEN_CLASSES.length);
  let landArea = 0;
  for (let r = 0; r < h; r++) {
    for (let col = 0; col < w; col++) {
      const k = c.koppen[r * w + col];
      if (k > 0) {
        cls[k] += aw[r];
        landArea += aw[r];
      }
    }
  }
  const koppenGroupAreas: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const koppenClassAreas: Record<string, number> = {};
  for (let k = 1; k < cls.length; k++) {
    if (cls[k] <= 0) continue;
    const pct = (100 * cls[k]) / landArea;
    koppenClassAreas[KOPPEN_CLASSES[k].code] = +pct.toFixed(2);
    koppenGroupAreas[KOPPEN_CLASSES[k].group] += pct;
  }
  for (const g of Object.keys(koppenGroupAreas)) koppenGroupAreas[g] = +koppenGroupAreas[g].toFixed(2);
  return {
    w, h,
    globalMeanTemp: areaMean(c.tempAnnual, w, h),
    globalPrecip: areaMean(c.precipAnnual, w, h),
    landFraction: areaMean(c.landFraction, w, h),
    koppenGroupAreas, koppenClassAreas, timings: c.timings, stats: c.stats,
  };
}
