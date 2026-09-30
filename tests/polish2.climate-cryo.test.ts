/**
 * Polish 2, climate cryosphere: land ice sheets from the snow/ice mass balance (energyStep.ts,
 * energyIce.ts), sea-ice seasonality (volume/area sea ice with basal ocean heat), near-pole numerics
 * (wavenumber-1-preserving polar filters, across-pole meridional smoothing) and cloud regimes relative
 * to the local condensation threshold.
 */
import { describe, expect, it } from 'vitest';
import type { ClimateInput, ClimateResult } from '../src/core/types';
import { computeClimate, DEFAULT_CLIMATE_PARAMS, type ClimateResultWithHydro } from '../src/climate/climate';
import { buildEarthClimateInput, REFERENCE_CITIES } from '../src/climate/earthInput';
import { makeGrid } from '../src/climate/dynGrid';
import { cloudCover } from '../src/climate/hydroCloud';
import { HYDRO_TUNING } from '../src/climate/hydroTuning';
import { KOPPEN_CLASSES } from '../src/climate/koppen';
import { blurSphere, makeHydroGrid } from '../src/climate/moistureGrid';
import { smoothField } from '../src/climate/numerics';
import { evaluateCity } from '../scripts/lib/earthMetrics';

const DEG = Math.PI / 180;

describe('near-pole numerics', () => {
  it('smoothField keeps a gradient across the pole and is mirror symmetric', () => {
    const g = makeGrid(180, 90);
    const f = new Float64Array(g.n);
    for (let j = 0; j < g.ny; j++) for (let c = 0; c < g.nx; c++) f[j * g.nx + c] = 10 * g.cosLat[j] * Math.cos(g.lon[c]) + 3 * g.sinLat[j];
    const s = f.slice();
    smoothField(g, s, 500, 3);
    // A linear function of the 3D position (smooth across the pole) passes almost unchanged, also in
    // the polar rows where the zonal boxes span the whole circle.
    let err = 0;
    for (let i = 0; i < g.n; i++) err = Math.max(err, Math.abs(s[i] - f[i]));
    expect(err).toBeLessThan(0.1);
    // Mirror symmetry (east ↔ west) of the operator on an arbitrary field.
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const r = new Float64Array(g.n);
    for (let i = 0; i < g.n; i++) r[i] = rnd();
    const mirror = (x: Float64Array): Float64Array => {
      const y = new Float64Array(g.n);
      for (let j = 0; j < g.ny; j++) for (let c = 0; c < g.nx; c++) y[j * g.nx + c] = x[j * g.nx + g.nx - 1 - c];
      return y;
    };
    const a = r.slice();
    smoothField(g, a, 700, 3);
    const b = mirror(r);
    smoothField(g, b, 700, 3);
    const bm = mirror(b);
    let d = 0;
    for (let i = 0; i < g.n; i++) d = Math.max(d, Math.abs(a[i] - bm[i]));
    expect(d).toBeLessThan(1e-9);
  });

  it('blurSphere keeps a gradient across the pole in the polar rows', () => {
    const g = makeHydroGrid(360, 180);
    const f = new Float64Array(g.n);
    for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) f[r * g.w + c] = 10 * g.cosLat[r] * g.cosLon[c];
    const s = blurSphere(g, f, 200);
    for (const r of [0, 1, g.h - 2, g.h - 1]) {
      for (let c = 0; c < g.w; c += 15) expect(Math.abs(s[r * g.w + c] - f[r * g.w + c])).toBeLessThan(0.02);
    }
  });
});

/** Blank ocean world with one low continent: a polar cap poleward of 70°S, or a same-area disc at 45°S. */
function capWorld(kind: 'polar' | 'mid', W: number, H: number): ClimateInput {
  const elev = new Float32Array(W * H);
  const landFraction = new Float32Array(W * H);
  const c0 = [Math.cos(-45 * DEG), 0, Math.sin(-45 * DEG)];
  for (let r = 0; r < H; r++) {
    const la = 90 - ((r + 0.5) * 180) / H;
    for (let c = 0; c < W; c++) {
      const lo = -180 + ((c + 0.5) * 360) / W;
      const x = Math.cos(la * DEG) * Math.cos(lo * DEG), y = Math.cos(la * DEG) * Math.sin(lo * DEG), z = Math.sin(la * DEG);
      const land = kind === 'polar' ? la < -70 : Math.acos(Math.min(1, x * c0[0] + y * c0[1] + z * c0[2])) < 20 * DEG;
      const i = r * W + c;
      elev[i] = land ? 300 + 100 * Math.sin(3 * lo * DEG) * Math.cos(2 * la * DEG) : -4000;
      landFraction[i] = land ? 1 : 0;
    }
  }
  return { w: W, h: H, elev, landFraction, sourceId: 3, time: 0 };
}

/** Land-area shares of Köppen codes (EF, ET, other groups) and of glacier cover ≥ 0.5 over land cells passing `sel`. */
function landShares(c: ClimateResult, sel: (lat: number) => boolean): { EF: number; ET: number; D: number; glacier: number } {
  const ice = (c as ClimateResultWithHydro).landIce;
  let ef = 0, et = 0, d = 0, gl = 0, tot = 0;
  for (let r = 0; r < c.h; r++) {
    const lat = 90 - ((r + 0.5) * 180) / c.h;
    if (!sel(lat)) continue;
    const wr = Math.cos(lat * DEG);
    for (let col = 0; col < c.w; col++) {
      const i = r * c.w + col;
      if (!c.land[i]) continue;
      const code = KOPPEN_CLASSES[c.koppen[i]].code;
      tot += wr;
      if (code === 'EF') ef += wr;
      else if (code === 'ET') et += wr;
      else if (code[0] === 'D') d += wr;
      if (ice && ice[i] >= 0.5) gl += wr;
    }
  }
  return { EF: ef / tot, ET: et / tot, D: d / tot, glacier: gl / tot };
}

/** Sea-ice area (fraction × ocean share × cell area) of one hemisphere and month, million km². */
function iceArea(c: ClimateResult, month: number, north: boolean): number {
  const { w, h } = c;
  const N = w * h;
  let a = 0;
  for (let r = 0; r < h; r++) {
    const lat = 90 - ((r + 0.5) * 180) / h;
    if (north ? lat < 0 : lat > 0) continue;
    const cellKm2 = 6371 ** 2 * ((2 * Math.PI) / w) * (Math.sin((lat + 90 / h) * DEG) - Math.sin((lat - 90 / h) * DEG));
    for (let col = 0; col < w; col++) {
      const i = r * w + col;
      a += c.seaIce[month * N + i] * (1 - c.landFraction[i]) * cellKm2;
    }
  }
  return a / 1e6;
}

describe('land ice sheets and sea ice on a blank-ocean world', () => {
  const W = 180;
  const H = 90;
  const params = { ...DEFAULT_CLIMATE_PARAMS, gridW: W, gridH: H };
  const polar = computeClimate(capWorld('polar', W, H), params);
  const mid = computeClimate(capWorld('mid', W, H), params);

  it('a low continent poleward of 70°S becomes an ice sheet (EF, glacier cover, cold summers)', () => {
    const s = landShares(polar, () => true);
    console.log(`polar cap: EF ${(100 * s.EF).toFixed(0)} % ET ${(100 * s.ET).toFixed(0)} % glacier ${(100 * s.glacier).toFixed(0)} %`);
    expect(s.EF).toBeGreaterThan(0.8);
    expect(s.EF + s.ET).toBeGreaterThan(0.97);
    expect(s.glacier).toBeGreaterThan(0.8);
    // Southern summer (January) stays below freezing over the ice sheet interior.
    const N = W * H;
    const r = H - 3;
    let jan = 0;
    for (let col = 0; col < W; col++) jan += polar.temp[r * W + col] / W;
    expect(jan).toBeLessThan(-5);
    expect(polar.snow[N * 0 + r * W]).toBeGreaterThan(0.95);
  });

  it('the same continent centred at 45°S does not glaciate', () => {
    const s = landShares(mid, () => true);
    console.log(`45° continent: EF ${(100 * s.EF).toFixed(0)} % ET ${(100 * s.ET).toFixed(0)} % glacier ${(100 * s.glacier).toFixed(0)} %`);
    expect(s.glacier).toBe(0);
    expect(s.EF).toBe(0);
    expect(s.ET).toBeLessThan(0.15); // its poleward tip (60–65°S) is tundra
  });

  it('sea ice follows the seasons around the ice sheet', () => {
    const sep = iceArea(polar, 8, false);
    const feb = iceArea(polar, 1, false);
    console.log(`polar-cap world, southern sea ice: Sep ${sep.toFixed(1)} M km², Feb ${feb.toFixed(1)} M km²`);
    expect(sep).toBeGreaterThan(3 * feb);
    expect(sep).toBeGreaterThan(8);
  });

  it('warm-starts an ice sheet without a cold bias (fast restarts do not drift)', () => {
    // Both polar caps glaciated and raised (energyIce.ts); January: northern polar night (surface
    // inversion in the reported temperatures) and southern summer. A fast warm start has a single
    // coupled year, so a seed taken from the reported temperatures without the ice raise and the
    // diagnostic inversion showed up as a 6–9 K colder January, growing with every restart.
    const input = capWorld('polar', W, H);
    for (let i = 0; i < W * H; i++) {
      const la = 90 - ((Math.floor(i / W) + 0.5) * 180) / H;
      if (la > 70) {
        input.elev[i] = 300;
        input.landFraction![i] = 1;
      }
    }
    const fast = { ...params, fast: true };
    const cold = computeClimate(input, fast);
    const warm = computeClimate(input, fast, undefined, cold);
    const warm2 = computeClimate(input, fast, undefined, warm);
    const jan = (c: ClimateResult, r: number): number => {
      let s = 0;
      for (let col = 0; col < W; col++) s += c.temp[r * W + col] / W;
      return s;
    };
    for (const r of [0, 3, H - 4, H - 1]) {
      expect(Math.abs(jan(warm, r) - jan(cold, r))).toBeLessThan(2.5);
      expect(Math.abs(jan(warm2, r) - jan(warm, r))).toBeLessThan(0.5);
    }
  });

  it('has no spikes or bands in the polar rows', () => {
    for (const c of [polar, mid]) {
      for (const [pole, next] of [[0, 1], [H - 1, H - 2], [H - 2, H - 3]]) {
        let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
        for (let col = 0; col < W; col++) {
          const a = c.precipAnnual[pole * W + col];
          const b = c.precipAnnual[next * W + col];
          lo = Math.min(lo, a);
          hi = Math.max(hi, a);
          lo2 = Math.min(lo2, b);
          hi2 = Math.max(hi2, b);
        }
        expect(hi).toBeLessThan(1.5 * hi2 + 20);
        expect(hi - lo).toBeLessThan(1.5 * (hi2 - lo2) + 20);
      }
    }
  });
});

describe('Earth cryosphere and clouds', () => {
  const W = 360;
  const H = 180;
  const N = W * H;
  const c = computeClimate(buildEarthClimateInput(W, H), { ...DEFAULT_CLIMATE_PARAMS });
  const box = (la0: number, la1: number, lo0: number, lo1: number) => (lat: number, lon: number): boolean =>
    lat >= la0 && lat <= la1 && lon >= lo0 && lon <= lo1;
  const shares = (inBox: (lat: number, lon: number) => boolean) => {
    const ice = (c as ClimateResultWithHydro).landIce!;
    let gl = 0, ef = 0, tot = 0;
    for (let r = 0; r < H; r++) {
      const lat = 90 - (r + 0.5);
      for (let col = 0; col < W; col++) {
        const lon = -180 + col + 0.5;
        const i = r * W + col;
        if (!c.land[i] || !inBox(lat, lon)) continue;
        const wr = Math.cos(lat * DEG);
        tot += wr;
        if (ice[i] >= 0.5) gl += wr;
        if (KOPPEN_CLASSES[c.koppen[i]].code === 'EF') ef += wr;
      }
    }
    return { glacier: gl / tot, EF: ef / tot };
  };

  it('glaciates Greenland and Antarctica, not Siberia, Canada or Scandinavia', () => {
    const gr = shares(box(60, 83, -55, -20));
    const an = shares(box(-90, -65, -180, 180));
    const si = shares(box(55, 75, 60, 140));
    const ca = shares(box(50, 70, -130, -60));
    const sc = shares(box(58, 71, 5, 30));
    console.log(`Earth glacier cover: Greenland ${(100 * gr.glacier).toFixed(0)} % Antarctica ${(100 * an.glacier).toFixed(0)} % Siberia ${(100 * si.glacier).toFixed(1)} % Canada ${(100 * ca.glacier).toFixed(1)} % Scandinavia ${(100 * sc.glacier).toFixed(1)} %`);
    expect(gr.glacier).toBeGreaterThan(0.85);
    expect(an.glacier).toBeGreaterThan(0.98);
    expect(an.EF).toBeGreaterThan(0.95);
    expect(si.glacier).toBeLessThan(0.01);
    expect(ca.glacier).toBeLessThan(0.03);
    expect(sc.glacier).toBeLessThan(0.03);
    expect(si.EF + ca.EF + sc.EF).toBeLessThan(0.03);
  });

  it('matches the Antarctic plateau stations within 3 °C on average', () => {
    const obs: Record<string, number> = { Vostok: -55.2, 'South Pole': -49.4, Concordia: -54.5 };
    let bias = 0;
    for (const [name, t] of Object.entries(obs)) {
      const r = evaluateCity(c, REFERENCE_CITIES.find((x) => x.name === name)!);
      expect(r.code).toBe('EF');
      bias += (r.tempAnnual - t) / 3;
    }
    console.log(`Antarctic plateau mean bias ${bias.toFixed(1)} °C`);
    expect(Math.abs(bias)).toBeLessThan(3);
  });

  it('has a winter southern ice edge near 60–64°S and summer ice mostly gone', () => {
    // Zonal mean of the equatorward-most latitude with ≥ 15 % ice.
    const edge = (m: number): number => {
      let s = 0, k = 0;
      for (let col = 0; col < W; col++) {
        for (let r = H / 2; r < H; r++) {
          const i = r * W + col;
          if (!c.land[i] && c.seaIce[m * N + i] >= 0.15) {
            s += 90 - (r + 0.5);
            k++;
            break;
          }
        }
      }
      return s / k;
    };
    const aug = edge(7);
    console.log(`Earth southern ice edge in August ${aug.toFixed(1)}°`);
    expect(aug).toBeLessThan(-59);
    expect(aug).toBeGreaterThan(-65);
    expect(iceArea(c, 1, false)).toBeLessThan(0.2 * iceArea(c, 8, false));
    expect(iceArea(c, 8, true)).toBeLessThan(0.4 * iceArea(c, 2, true));
  });

  it('has cloudy rainforests, clear deserts and a cloudier land surface', () => {
    const mean = (la0: number, la1: number, lo0: number, lo1: number, only: 'land' | 'ocean' | 'all'): number => {
      let s = 0, ws = 0;
      for (let r = 0; r < H; r++) {
        const lat = 90 - (r + 0.5);
        if (lat < la0 || lat > la1) continue;
        const wr = Math.cos(lat * DEG);
        for (let col = 0; col < W; col++) {
          const lon = -180 + col + 0.5;
          if (lon < lo0 || lon > lo1) continue;
          const i = r * W + col;
          if ((only === 'land' && !c.land[i]) || (only === 'ocean' && c.land[i])) continue;
          for (let m = 0; m < 12; m++) {
            s += wr * c.cloud[m * N + i];
            ws += wr;
          }
        }
      }
      return s / ws;
    };
    const amazon = mean(-10, 5, -75, -50, 'land');
    const congo = mean(-5, 5, 12, 28, 'land');
    const sahara = mean(15, 30, -10, 30, 'land');
    const land = mean(-60, 90, -180, 180, 'land');
    const global = mean(-90, 90, -180, 180, 'all');
    console.log(`Earth clouds: Amazon ${amazon.toFixed(2)} Congo ${congo.toFixed(2)} Sahara ${sahara.toFixed(2)} land (ex. Antarctica) ${land.toFixed(2)} global ${global.toFixed(2)}`);
    expect(amazon).toBeGreaterThan(0.65);
    expect(congo).toBeGreaterThan(0.65);
    expect(sahara).toBeLessThan(0.25);
    expect(land).toBeGreaterThan(0.55);
    expect(global).toBeGreaterThan(0.55);
    expect(global).toBeLessThan(0.68);
  });

  it('cloud cover follows RH relative to the local condensation threshold', () => {
    const t = HYDRO_TUNING;
    // The same column RH is cloudier where precipitation sets in at a lower RH (land, convection):
    // computeCloudCover passes rh·(r0_ocean / r0_local)^e to cloudCover.
    const ocean = cloudCover(0.45, 0, 0, 0, t);
    const land = cloudCover(0.45 * Math.pow(t.gateThreshold / 0.5, t.cloudThresholdExponent), 0, 0, 0, t);
    expect(land).toBeGreaterThan(ocean + 0.1);
  });
});
