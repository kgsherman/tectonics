import { describe, expect, it } from 'vitest';
import { buildEarthClimateInput } from '../../src/climate/earthInput';
import { renderClimateLayer } from '../../scripts/lib/climateImages';
import { zonalClimate } from '../helpers/fixtures';

const now = (): number => performance.now();

describe('headless perf (Node, shared machine: budgets carry ~2x slack)', () => {
  it('builds the Earth input quickly (cold, per size)', () => {
    for (const [w, h, budget] of [[360, 180, 1500], [1440, 720, 2000], [180, 90, 1000]] as const) {
      const t = now();
      buildEarthClimateInput(w, h);
      const ms = now() - t;
      console.log(`buildEarthClimateInput ${w}x${h}: ${ms.toFixed(0)} ms (budget ${budget})`);
      expect(ms).toBeLessThan(budget);
    }
    const t = now();
    buildEarthClimateInput(360, 180);
    console.log(`buildEarthClimateInput 360x180 cached: ${(now() - t).toFixed(1)} ms`);
    expect(now() - t).toBeLessThan(20);
  });

  it('renders climate reference images quickly', () => {
    const c = zonalClimate(360, 180);
    const t = now();
    for (const layer of ['currents', 'wind', 'koppen', 'precipitation'] as const) renderClimateLayer(layer, c, 6, 1080, 540);
    const ms = (now() - t) / 4;
    console.log(`renderClimateLayer 1080x540: ${ms.toFixed(0)} ms/layer`);
    expect(ms).toBeLessThan(400);
  });
});
