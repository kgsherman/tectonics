/**
 * Earth validation of the climate dynamics (SPEC §6.2/6.4 targets) on the present-day Earth input.
 */
import { describe, expect, it } from 'vitest';
import { computeDynamics } from '../src/climate/dyn';
import { buildEarthClimateInput } from '../src/climate/earthInput';
import { DEFAULT_CLIMATE_PARAMS } from '../src/climate/climate';

const W = 360;
const H = 180;
const N = W * H;
const d = computeDynamics(buildEarthClimateInput(W, H), { ...DEFAULT_CLIMATE_PARAMS });

const idx = (lat: number, lon: number): number =>
  Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H))) * W + (((Math.floor(((lon + 180) / 360) * W) % W) + W) % W);
const annual = (f: Float32Array, i: number): number => {
  let s = 0;
  for (let m = 0; m < 12; m++) s += f[m * N + i] / 12;
  return s;
};
/** Mean of f over a lat/lon box (optionally ocean or land only), months given. */
function boxMean(f: Float32Array, months: number[], lat0: number, lat1: number, lon0: number, lon1: number, mask?: 'ocean' | 'land'): number {
  let s = 0;
  let k = 0;
  for (let r = 0; r < H; r++) {
    const la = 90 - ((r + 0.5) * 180) / H;
    if (la < lat0 || la > lat1) continue;
    for (let c = 0; c < W; c++) {
      const lo = -180 + ((c + 0.5) * 360) / W;
      if (lo < lon0 || lo > lon1) continue;
      const i = r * W + c;
      if (mask === 'ocean' && d.land[i]) continue;
      if (mask === 'land' && !d.land[i]) continue;
      for (const m of months) {
        s += f[m * N + i];
        k++;
      }
    }
  }
  return s / k;
}
const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

describe('Earth dynamics', () => {
  it('reproduces zonal-mean temperatures and seasons', () => {
    // Observed zonal means (°C): annual, January, July.
    const obs: Array<[number, number, number, number]> = [
      [70, -10, -24, 6], [50, 5.5, -6, 16], [30, 19.5, 13, 26], [10, 26.5, 25, 27], [-10, 25.5, 26, 24],
      [-30, 18.5, 22, 14], [-50, 6.5, 8, 3.5], [-70, -12, -4, -20],
    ];
    let se = 0;
    for (const [lat, a, j, jl] of obs) {
      const ann = boxMean(d.temp, ALL, lat - 2.5, lat + 2.5, -180, 180);
      const jan = boxMean(d.temp, [0], lat - 2.5, lat + 2.5, -180, 180);
      const jul = boxMean(d.temp, [6], lat - 2.5, lat + 2.5, -180, 180);
      se += (ann - a) ** 2 + 0.5 * (jan - j) ** 2 + 0.5 * (jul - jl) ** 2;
    }
    expect(Math.sqrt(se / (2 * obs.length))).toBeLessThan(4);
    // Seasonal ranges: extreme in NE Siberia, moderate in maritime western Europe.
    const range = (lat: number, lon: number): number => d.temp[6 * N + idx(lat, lon)] - d.temp[idx(lat, lon)];
    expect(range(62, 130)).toBeGreaterThan(35);
    expect(range(51.5, -0.1)).toBeLessThan(20);
    expect(range(62, 130)).toBeGreaterThan(range(51.5, -0.1) + 15);
  });

  it('has trades and westerlies of realistic strength', () => {
    const speed = new Float32Array(12 * N);
    for (let i = 0; i < 12 * N; i++) speed[i] = Math.hypot(d.windU[i], d.windV[i]);
    const tradesN = boxMean(speed, ALL, 10, 20, -180, 180, 'ocean');
    const tradesS = boxMean(speed, ALL, -20, -10, -180, 180, 'ocean');
    const westS = boxMean(d.windU, ALL, -55, -45, -180, 180, 'ocean');
    const westN = boxMean(d.windU, [0, 1, 11], 40, 50, -180, 180, 'ocean');
    for (const s of [tradesN, tradesS]) {
      expect(s).toBeGreaterThan(4);
      expect(s).toBeLessThan(9);
    }
    expect(boxMean(d.windU, ALL, 10, 20, -180, 180, 'ocean')).toBeLessThan(-2);
    expect(westS).toBeGreaterThan(4);
    expect(westN).toBeGreaterThan(3);
  });

  it('reverses the Indian monsoon and builds the Siberian winter high', () => {
    const i = idx(15, 65);
    expect(d.windU[i]).toBeLessThan(0);
    expect(d.windV[i]).toBeLessThan(0);
    expect(d.windU[6 * N + i]).toBeGreaterThan(0);
    expect(d.windV[6 * N + i]).toBeGreaterThan(0);
    const sib = idx(50, 100);
    expect(d.pressure[sib]).toBeGreaterThan(1018);
    expect(d.pressure[6 * N + sib]).toBeLessThan(d.pressure[sib] - 10);
  });

  it('drives western-intensified gyres and the Antarctic Circumpolar Current', () => {
    const speed = new Float32Array(12 * N);
    for (let i = 0; i < 12 * N; i++) speed[i] = Math.hypot(d.currentU[i], d.currentV[i]);
    const gulf = boxMean(speed, ALL, 30, 40, -80, -65, 'ocean');
    const atlInterior = boxMean(speed, ALL, 25, 35, -50, -30, 'ocean');
    const kuroshio = boxMean(speed, ALL, 30, 38, 128, 145, 'ocean');
    const pacInterior = boxMean(speed, ALL, 25, 35, -170, -140, 'ocean');
    expect(gulf).toBeGreaterThan(1.5 * atlInterior);
    expect(kuroshio).toBeGreaterThan(1.5 * pacInterior);
    // Gulf Stream and Kuroshio flow poleward/eastward along the western boundaries.
    expect(boxMean(d.currentV, ALL, 25, 33, -81, -76, 'ocean')).toBeGreaterThan(0);
    expect(boxMean(d.currentV, ALL, 22, 30, 121, 128, 'ocean')).toBeGreaterThan(0);
    expect(boxMean(d.currentU, ALL, -60, -45, -180, 180, 'ocean')).toBeGreaterThan(0.03);
  });

  it('has cold eastern-boundary upwelling tongues and warm western boundary currents', () => {
    const sstAnom = (lat: number, lon: number): number => {
      const i = idx(lat, lon);
      const zonal = boxMean(d.sst, ALL, lat - 1, lat + 1, -180, 180, 'ocean');
      return annual(d.sst, i) - zonal;
    };
    expect(sstAnom(-15, -77)).toBeLessThan(-1); // Peru
    expect(sstAnom(-22, 12)).toBeLessThan(-0.5); // Benguela
    expect(sstAnom(25, -17)).toBeLessThan(-0.5); // Canaries
    expect(sstAnom(38, -68)).toBeGreaterThan(1); // Gulf Stream
    let up = 0;
    for (let m = 0; m < 12; m++) up += d.upwelling[m * N + idx(-15, -77)] / 12;
    expect(up).toBeGreaterThan(0.1);
  });

  it('has seasonal sea ice in both hemispheres', () => {
    const area = (m: number, north: boolean): number => {
      let a = 0;
      for (let r = 0; r < H; r++) {
        const la = 90 - ((r + 0.5) * 180) / H;
        if (north !== la > 0) continue;
        const ca = 2 * Math.PI * 6371 ** 2 * Math.cos((la * Math.PI) / 180) * (Math.PI / H) / W;
        for (let c = 0; c < W; c++) if (!d.land[r * W + c]) a += d.seaIce[m * N + r * W + c] * ca;
      }
      return a / 1e6;
    };
    expect(area(2, true)).toBeGreaterThan(area(8, true) + 5);
    expect(area(8, false)).toBeGreaterThan(area(1, false) + 5);
    expect(area(2, true)).toBeLessThan(35);
    expect(area(8, false)).toBeLessThan(40);
  });
});
