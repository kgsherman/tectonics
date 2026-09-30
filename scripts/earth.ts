/**
 * Run the climate model on present-day Earth and report how close it is to observations.
 *
 *   npx tsx scripts/earth.ts [--size 360x180] [--fast] [--out out/earth] [--scale 3] [--tilt 23.44]
 *                            [--satellite 2048x1024] [--mesh 160000] [--month 6]
 *
 * Writes <out>/climate/*.png (Köppen with reference cities, T, P, SST, currents, winds, pressure,
 * sea ice, snow, clouds), <out>/report.txt and <out>/report.json. With --satellite WxH, also paints
 * Earth with the real painter (satellite + Köppen for --month, on a --mesh-cell sphere) into
 * <out>/painted/. Exit code 3 when the climate model is not available yet (contract stub), 1 on
 * other failures.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './cli';
import { EARTH_IMAGE_JOBS, writeEarthOutputs } from './lib/earthOutputs';
import { runEarthClimate } from './lib/earthRun';
import { earthSnapshot, paintEarth } from './lib/earthWorld';
import { runStage, type StageLog } from './lib/stage';
import { createSphereMesh } from '../src/core/sphereMesh';
import { writePng } from './png';
import { parseSize } from './lib/gridUtil';

const args = parseArgs(process.argv.slice(2), {
  size: '360x180', fast: false, out: 'out/earth', scale: 3, tilt: 23.44, satellite: '', mesh: 160_000, month: 6,
});

async function main(): Promise<number> {
  const [w, h] = parseSize(args.size);
  console.log(`Earth climate ${w}x${h}${args.fast ? ' (fast)' : ''}`);
  const run = await runEarthClimate({ w, h, fast: args.fast, params: { axialTilt: args.tilt } });
  if (!run.result || !run.metrics) {
    const st = run.stages.computeClimate ?? run.stages.loadClimateModule;
    console.log(`climate unavailable: ${st?.status} ${st?.message ?? ''}`);
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, 'report.json'), JSON.stringify({ stages: run.stages }, null, 2));
    return st?.status === 'not-implemented' ? 3 : 1;
  }
  const report = writeEarthOutputs(args.out, run.result, run.metrics, { fast: args.fast, computeMs: run.climateMs }, args.scale);
  console.log('\n' + report);
  console.log(`\ncomputeClimate: ${run.climateMs.toFixed(0)} ms; stage timings: ${JSON.stringify(run.result.timings)}`);
  console.log(`wrote report + ${EARTH_IMAGE_JOBS.length} images to ${args.out}`);
  if (args.satellite) {
    const [W, H] = parseSize(args.satellite);
    const stages: StageLog = {};
    const mesh = createSphereMesh(args.mesh);
    const snap = earthSnapshot(mesh);
    for (const layer of ['satellite', 'koppen'] as const) {
      const res = await runStage(stages, `paint:${layer}`, () => paintEarth(mesh, snap, run.result, layer, { width: W, height: H, month: args.month }));
      if (res) writePng(join(args.out, 'painted', `${layer}_m${args.month}.png`), { width: res.width, height: res.height, rgba: res.rgba });
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
