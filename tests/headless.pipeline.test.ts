import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HEADLESS_OPTIONS, runHeadless, type HeadlessStats } from '../scripts/lib/headlessPipeline';

const OUT = 'scratch/headless/tests/pipeline';
const ALLOWED = new Set(['ok', 'fallback', 'not-implemented', 'error', 'skipped']);

describe('headless pipeline', () => {
  it('runs end to end (degrading gracefully) and writes PNGs + stats.json', async () => {
    rmSync(OUT, { recursive: true, force: true });
    const stats = await runHeadless({
      ...DEFAULT_HEADLESS_OPTIONS,
      n: 3000, myr: 2, out: OUT, width: 128, height: 64, climate: 'fast', climateW: 90, climateH: 45,
      layers: ['satellite', 'elevation', 'plates', 'crust', 'crustAge', 'temperature', 'koppen'],
      verbose: false,
    });
    for (const [name, st] of Object.entries(stats.stages)) {
      expect(ALLOWED.has(st.status), `${name}: ${st.status}`).toBe(true);
      expect(st.ms).toBeGreaterThanOrEqual(0);
    }
    // A world always exists (generated, simulated or the synthetic fallback), so world layers render.
    expect(stats.world).not.toBeNull();
    expect(stats.world!.landFraction).toBeGreaterThanOrEqual(0);
    expect(stats.world!.landFraction).toBeLessThanOrEqual(1);
    expect(stats.world!.elevation.max).toBeGreaterThanOrEqual(stats.world!.elevation.min);
    for (const layer of ['satellite', 'elevation', 'plates', 'crust', 'crustAge']) {
      const info = stats.layers[layer];
      expect(info.renderer, layer).not.toBe('none');
      expect(existsSync(join(OUT, `${layer}.png`))).toBe(true);
    }
    // Without a climate, the painter (if available) draws its neutral fallback; the headless reference
    // renderer can only draw climate layers when a climate exists.
    const hasClimate = stats.climate !== null;
    const k = stats.layers.koppen.renderer;
    if (k === 'fallback') expect(hasClimate).toBe(true);
    if (k === 'none') expect(hasClimate).toBe(false);
    expect(stats.layers.plates.file).toBe('plates.png');
    const onDisk = JSON.parse(readFileSync(join(OUT, 'stats.json'), 'utf8')) as HeadlessStats;
    expect(onDisk.options.n).toBe(3000);
    expect(Object.keys(onDisk.stages)).toContain('generate');
    expect(onDisk.timings.total).toBeGreaterThan(0);
    expect(onDisk.timings.mesh).toBeGreaterThanOrEqual(0);
  });
});
