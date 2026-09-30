/**
 * Headless world generator (SPEC §11): generate → simulate → climate → paint, writing PNGs and
 * stats.json. Degrades gracefully while modules are still stubs (see scripts/lib/headlessPipeline.ts).
 *
 *   npx tsx scripts/headless.ts --seed 7 --n 40000 --myr 150 --out out/seed7 \
 *     --layers satellite,elevation,plates,koppen --size 2048x1024 --month 6 --climate full
 *
 * Options: --seed --n --myr --out --layers (comma list or "all") --size WxH --month (0..11, −1 annual)
 * --climate full|fast|none --climateSize WxH --plates --continents --mode scattered|supercontinent|archipelago
 * --quality full|preview --seaLevel --overlay true|false
 */
import type { LayerId } from '../src/core/types';
import { parseArgs } from './cli';
import { ALL_LAYERS, DEFAULT_HEADLESS_OPTIONS as D, runHeadless, type HeadlessOptions } from './lib/headlessPipeline';
import { parseSize } from './lib/gridUtil';

const a = parseArgs(process.argv.slice(2), {
  seed: D.seed, n: D.n, myr: D.myr, out: D.out, layers: D.layers.join(','), size: `${D.width}x${D.height}`,
  month: D.month, climate: D.climate as string, climateSize: `${D.climateW}x${D.climateH}`, plates: D.plates,
  continents: D.continents, mode: D.mode as string, quality: D.quality as string, seaLevel: D.seaLevel, overlay: D.overlay,
});

function oneOf<T extends string>(name: string, v: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`--${name} must be one of ${allowed.join('|')}, got "${v}"`);
  return v as T;
}

const layers = a.layers === 'all' ? [...ALL_LAYERS] : a.layers.split(',').map((s) => oneOf<LayerId>('layers', s.trim(), ALL_LAYERS));
const [width, height] = parseSize(a.size);
const [climateW, climateH] = parseSize(a.climateSize);
if (a.month < -1 || a.month > 11 || !Number.isInteger(a.month)) throw new Error('--month must be an integer in -1..11');

const opts: HeadlessOptions = {
  seed: a.seed, n: a.n, myr: a.myr, out: a.out, layers, width, height, month: a.month,
  climate: oneOf('climate', a.climate, ['full', 'fast', 'none'] as const), climateW, climateH,
  plates: a.plates, continents: a.continents, mode: oneOf('mode', a.mode, ['scattered', 'supercontinent', 'archipelago'] as const),
  quality: oneOf('quality', a.quality, ['full', 'preview'] as const), seaLevel: a.seaLevel, overlay: a.overlay, verbose: true,
};

runHeadless(opts).then(
  (stats) => {
    const failed = Object.entries(stats.stages).filter(([, s]) => s.status === 'error');
    if (failed.length) console.log(`stages with errors: ${failed.map(([k]) => k).join(', ')}`);
    process.exit(failed.length ? 1 : 0);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
