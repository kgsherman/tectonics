/**
 * Calibration sweep over climate tuning constants, scored against present-day Earth.
 *
 *   npx tsx scripts/calibrate.ts --module src/climate/tuning.ts --export ebmTuning \
 *     --ranges '{"diffusion":[0.5,0.62,0.75],"olrB":{"from":1.9,"to":2.3,"steps":3}}' \
 *     [--rangesFile ranges.json] [--size 180x90] [--fast] [--max 60] [--seed 1] \
 *     [--sort score|zonalRmse|precip|areas|groupHit|codeHit] [--top 20] [--out out/calibrate]
 *
 * The export must be a mutable object that the model reads at call time. Without --export, range
 * keys are "exportName.path" into the module. Keys may be dotted paths into nested objects.
 * Ranges: [values] | {"values":[...]} | {"from":a,"to":b,"steps":n,"log"?:true}. The full grid is
 * run when it has ≤ --max combinations, else --max random combinations. The baseline (current
 * values) is always evaluated first. Results: ranked table on stdout + <out>/results.json/.csv.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EARTH_GLOBAL_PRECIP_MM } from '../src/climate/earthInput';
import { parseArgs } from './cli';
import {
  combinations, formatTable, gridSize, parseRanges, rankRows, runSweep, type RangeSpec, type SweepRow,
} from './lib/calibration';
import { metricsToJson, type EarthMetrics } from './lib/earthMetrics';
import { runEarthClimate } from './lib/earthRun';
import { parseSize } from './lib/gridUtil';

const a = parseArgs(process.argv.slice(2), {
  module: 'src/climate/tuning.ts', export: '', ranges: '', rangesFile: '', size: '180x90', fast: false,
  max: 60, seed: 1, sort: 'score', top: 20, out: 'out/calibrate',
});

const SORTS: Record<string, { key: (m: EarthMetrics) => number; desc?: boolean }> = {
  score: { key: (m) => m.score },
  zonalRmse: { key: (m) => m.zonalRmse },
  precip: { key: (m) => Math.abs(m.globalPrecip - EARTH_GLOBAL_PRECIP_MM) },
  areas: { key: (m) => m.groupAreaError },
  groupHit: { key: (m) => m.groupHitRate, desc: true },
  codeHit: { key: (m) => m.codeHitRate, desc: true },
};

async function main(): Promise<number> {
  const sort = SORTS[a.sort];
  if (!sort) throw new Error(`--sort must be one of ${Object.keys(SORTS).join('|')}`);
  const rangeText = a.rangesFile ? readFileSync(a.rangesFile, 'utf8') : a.ranges;
  if (!rangeText) throw new Error('give --ranges <json> or --rangesFile <path>');
  const ranges = parseRanges(JSON.parse(rangeText) as Record<string, RangeSpec>);
  const [w, h] = parseSize(a.size);

  // Import the tuning module by file URL: the same module instance the climate model imports.
  const mod = (await import(pathToFileURL(resolve(a.module)).href)) as Record<string, unknown>;
  let target: unknown = mod;
  if (a.export) {
    target = mod[a.export];
    if (!target || typeof target !== 'object') throw new Error(`${a.module} has no object export "${a.export}" (exports: ${Object.keys(mod).join(', ')})`);
  }

  const combos = combinations(ranges, a.max, a.seed);
  console.log(`calibrating ${a.module}${a.export ? `#${a.export}` : ''} on Earth ${w}x${h}${a.fast ? ' (fast)' : ''}: ` +
    `${combos.length} of ${gridSize(ranges)} combinations + baseline`);

  const rows = await runSweep<EarthMetrics>(
    target, combos,
    async () => {
      const run = await runEarthClimate({ w, h, fast: a.fast, verbose: false });
      if (!run.metrics) {
        const st = run.stages.computeClimate ?? run.stages.loadClimateModule;
        throw new Error(`climate ${st?.status ?? 'failed'}: ${st?.message ?? ''}`);
      }
      return run.metrics;
    },
    (row, i, n) => {
      const m = row.metrics;
      const desc = Object.entries(row.combo).map(([k, v]) => `${k}=${fmt(v)}`).join(' ');
      console.log(`  [${i + 1}/${n}] ${row.baseline ? '(baseline) ' : ''}${desc} → ` +
        (m ? `score ${m.score.toFixed(3)} (${(row.ms / 1000).toFixed(1)} s)` : `FAILED: ${row.error}`));
    },
  );

  const ok = rows.filter((r) => r.metrics);
  if (ok.length === 0) {
    console.log('no successful evaluations (is the climate model implemented?)');
    return 3;
  }
  const scores = new Set(ok.map((r) => r.metrics!.score.toFixed(9)));
  if (ok.length > 1 && scores.size === 1) {
    console.warn('WARNING: every combination gave identical metrics — the parameters had no effect. Does the model read ' +
      'this tuning object at call time (not a copy made at import), and is the path right?');
  }

  const ranked = rankRows(rows, sort.key, sort.desc);
  const keys = Object.keys(ranges);
  const header = ['rank', 'score', 'T rmse', 'P mm', 'area L1', 'grp hit%', 'code hit%', 'sec', ...keys];
  const table = ranked.slice(0, a.top).map((r, i) => {
    const m = r.metrics;
    return [
      `${i + 1}${r.baseline ? '*' : ''}`,
      m ? m.score.toFixed(3) : 'FAIL',
      m ? m.zonalRmse.toFixed(2) : '',
      m ? m.globalPrecip.toFixed(0) : '',
      m ? m.groupAreaError.toFixed(1) : '',
      m ? (100 * m.groupHitRate).toFixed(0) : '',
      m ? (100 * m.codeHitRate).toFixed(0) : '',
      (r.ms / 1000).toFixed(1),
      ...keys.map((k) => fmt(r.combo[k])),
    ];
  });
  console.log(`\nranked by ${a.sort} (* = baseline):\n` + formatTable(header, table));

  mkdirSync(a.out, { recursive: true });
  writeFileSync(join(a.out, 'results.json'), JSON.stringify({
    module: a.module, export: a.export, size: [w, h], fast: a.fast, sort: a.sort,
    rows: ranked.map((r: SweepRow<EarthMetrics>) => ({ ...r, metrics: r.metrics ? metricsToJson(r.metrics) : null })),
  }, null, 2));
  const csv = [['baseline', 'score', 'zonalRmse', 'globalPrecip', 'groupAreaError', 'groupHitRate', 'codeHitRate', 'ms', ...keys].join(',')];
  for (const r of ranked) {
    const m = r.metrics;
    csv.push([r.baseline, m?.score ?? '', m?.zonalRmse ?? '', m?.globalPrecip ?? '', m?.groupAreaError ?? '', m?.groupHitRate ?? '', m?.codeHitRate ?? '', r.ms.toFixed(0), ...keys.map((k) => r.combo[k])].join(','));
  }
  writeFileSync(join(a.out, 'results.csv'), csv.join('\n') + '\n');
  console.log(`\nwrote ${join(a.out, 'results.json')} and results.csv`);
  return 0;
}

function fmt(v: number): string {
  return Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : String(+v.toPrecision(5));
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
