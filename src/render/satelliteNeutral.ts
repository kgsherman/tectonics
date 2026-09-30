/**
 * Neutral satellite attributes when no climate is available: a zonal, moderately humid Earth-like
 * stand-in (temperature from latitude and season, uniform moderate rainfall — no deserts invented),
 * so terrain still reads naturally (greens, tundra, ice caps, snow on high ground).
 */
import { gridLat } from '../core/grid';
import { classifyKoppen } from '../climate/koppen';
import type { PaintCache } from './paintCache';
import { buildSatelliteGrid } from './satelliteBiome';
import type { SatelliteClimate, SatelliteGrid } from './satelliteBiome';

const NEUTRAL_W = 4;
const NEUTRAL_H = 90;

function neutralClimate(): SatelliteClimate {
  const w = NEUTRAL_W, h = NEUTRAL_H, N = w * h;
  const temp = new Float32Array(12 * N), precip = new Float32Array(12 * N);
  const seaIce = new Float32Array(12 * N), sst = new Float32Array(12 * N);
  const koppenAll = new Uint8Array(N);
  const tt = new Float32Array(12), pp = new Float32Array(12);
  for (let r = 0; r < h; r++) {
    const lat = gridLat(h, r);
    const s = Math.sin(lat);
    for (let m = 0; m < 12; m++) {
      // Declination-like seasonal term, NH summer in July.
      const season = Math.sin((2 * Math.PI * (m + 0.5 - 3.7)) / 12) * s;
      tt[m] = 27 - 44 * s * s + 14 * season;
      pp[m] = 75;
    }
    const k = classifyKoppen(tt, pp, lat < 0);
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      koppenAll[i] = k;
      for (let m = 0; m < 12; m++) {
        temp[m * N + i] = tt[m];
        precip[m * N + i] = pp[m];
        sst[m * N + i] = Math.max(-1.8, tt[m]);
        seaIce[m * N + i] = tt[m] < -4 ? Math.min(1, (-4 - tt[m]) / 8) : 0;
      }
    }
  }
  return { w, h, land: new Uint8Array(N), elev: new Float32Array(N), temp, precip, seaIce, sst, koppenAll, seaLevel: 0 };
}

export function neutralSatelliteGrid(month: number, cache: PaintCache): SatelliteGrid {
  return cache.getOrBuild(`satgrid|neutral|${month}`, () => buildSatelliteGrid(neutralClimate(), month));
}
