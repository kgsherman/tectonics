/**
 * Polish-phase Earth validation of the whole climate (computeClimate on buildEarthClimateInput at
 * 360×180): zonal temperature, sea-ice areas by season, western boundary currents, global water
 * budget and a physically structured cloud field. Thresholds sit a little outside the calibrated
 * values (see scratch/climate for the calibration harness) so regressions show up.
 */
import { describe, expect, it } from 'vitest';
import type { ClimateResult } from '../src/core/types';
import { computeClimate, DEFAULT_CLIMATE_PARAMS } from '../src/climate/climate';
import { buildEarthClimateInput, EARTH_ZONAL_MEAN_TEMP } from '../src/climate/earthInput';
import { computeEarthMetrics } from '../scripts/lib/earthMetrics';

const W = 360;
const H = 180;
const N = W * H;
const DEG = Math.PI / 180;
const c = computeClimate(buildEarthClimateInput(W, H), { ...DEFAULT_CLIMATE_PARAMS });

const latOf = (r: number): number => 90 - ((r + 0.5) * 180) / H;
const lonOf = (col: number): number => -180 + ((col + 0.5) * 360) / W;

/** Sea-ice area (fraction-weighted, open-ocean share of each cell), million km². */
function iceArea(r: ClimateResult, month: number, north: boolean): number {
  let a = 0;
  for (let row = 0; row < H; row++) {
    const lat = latOf(row);
    if (north ? lat < 0 : lat > 0) continue;
    const cellKm2 = 6371 ** 2 * ((2 * Math.PI) / W) * (Math.sin((lat + 0.5) * DEG) - Math.sin((lat - 0.5) * DEG));
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      a += r.seaIce[month * N + i] * (1 - r.landFraction[i]) * cellKm2;
    }
  }
  return a / 1e6;
}

/** Area-weighted mean of an annual-mean monthly field over a lat/lon box (optionally ocean or land only). */
function boxMean(f: Float32Array, la0: number, la1: number, lo0: number, lo1: number, only?: 'land' | 'ocean'): number {
  let s = 0, wsum = 0;
  for (let row = 0; row < H; row++) {
    const lat = latOf(row);
    if (lat < la0 || lat > la1) continue;
    const wr = Math.cos(lat * DEG);
    for (let col = 0; col < W; col++) {
      const lon = lonOf(col);
      if (lon < lo0 || lon > lo1) continue;
      const i = row * W + col;
      if (only === 'land' && !c.land[i]) continue;
      if (only === 'ocean' && c.land[i]) continue;
      for (let m = 0; m < 12; m++) {
        s += wr * f[m * N + i];
        wsum += wr;
      }
    }
  }
  return s / wsum;
}

/** Largest annual-mean surface current speed in a box (m/s). */
function peakCurrent(la0: number, la1: number, lo0: number, lo1: number): number {
  let best = 0;
  for (let row = 0; row < H; row++) {
    const lat = latOf(row);
    if (lat < la0 || lat > la1) continue;
    for (let col = 0; col < W; col++) {
      const lon = lonOf(col);
      if (lon < lo0 || lon > lo1) continue;
      const i = row * W + col;
      if (c.land[i]) continue;
      let u = 0, v = 0;
      for (let m = 0; m < 12; m++) {
        u += c.currentU[m * N + i] / 12;
        v += c.currentV[m * N + i] / 12;
      }
      best = Math.max(best, Math.hypot(u, v));
    }
  }
  return best;
}

describe('Earth climate polish targets', () => {
  it('matches the zonal-mean annual temperature', () => {
    let se = 0, sw = 0, worst = 0;
    EARTH_ZONAL_MEAN_TEMP.forEach((obs, b) => {
      const lat = 85 - 10 * b;
      const model = c.stats[`zonalMeanTemp${lat}`];
      const wgt = Math.cos(lat * DEG);
      se += wgt * (model - obs) ** 2;
      sw += wgt;
      // Antarctic bands (70–90°S) get the wider margin. The 70–80°S band is ≈ 3 K colder than this
      // reference since the land ice-sheet mass balance cooled the East Antarctic interior (bringing
      // Vostok / Concordia in that band from ≈ +7…+10 K to ≈ +3…+7 K too warm), although its ocean
      // part (the Ross/Ronne ice shelves are sea ice at ≈ −13 °C in the Earth input) is too warm; the
      // plateau stations are checked separately (tests/polish2.climate-cryo.test.ts).
      if (b < 16) worst = Math.max(worst, Math.abs(model - obs));
      else expect(Math.abs(model - obs)).toBeLessThan(4.5);
    });
    const rmse = Math.sqrt(se / sw);
    console.log(`Earth zonal T RMSE ${rmse.toFixed(2)} °C, worst band ${worst.toFixed(1)} °C`);
    expect(rmse).toBeLessThan(1.3);
    expect(worst).toBeLessThan(2.6);
  });

  it('matches the Köppen group shares and the reference cities', () => {
    const m = computeEarthMetrics(c);
    const g = m.groupAreas;
    console.log(`Earth Köppen A ${g.A.toFixed(1)} B ${g.B.toFixed(1)} C ${g.C.toFixed(1)} D ${g.D.toFixed(1)} E ${g.E.toFixed(1)} (L1 ${m.groupAreaError.toFixed(1)} pp); cities group ${(100 * m.groupHitRate).toFixed(1)} %, code ${(100 * m.codeHitRate).toFixed(1)} %`);
    expect(m.groupAreaError).toBeLessThan(9);
    expect(m.groupHitRate).toBeGreaterThanOrEqual(0.8);
    expect(m.codeHitRate).toBeGreaterThanOrEqual(0.44);
  });

  it('has seasonal sea-ice areas in the observed ranges', () => {
    const nhMar = iceArea(c, 2, true), nhSep = iceArea(c, 8, true), shSep = iceArea(c, 8, false), shFeb = iceArea(c, 1, false);
    console.log(`Earth sea ice (M km²): NH Mar ${nhMar.toFixed(1)} Sep ${nhSep.toFixed(1)}; SH Sep ${shSep.toFixed(1)} Feb ${shFeb.toFixed(1)}`);
    expect(nhMar).toBeGreaterThan(12);
    expect(nhMar).toBeLessThan(18);
    expect(nhSep).toBeGreaterThan(2.5);
    expect(nhSep).toBeLessThan(7.5);
    expect(shSep).toBeGreaterThan(14);
    expect(shSep).toBeLessThan(21);
    expect(shFeb).toBeGreaterThan(1.5);
    expect(shFeb).toBeLessThan(5.5);
  });

  it('has fast western boundary currents and a closed water budget', () => {
    const gulf = peakCurrent(25, 45, -82, -45);
    const kuroshio = peakCurrent(22, 42, 120, 160);
    console.log(`Earth WBC peak speeds: Gulf Stream ${gulf.toFixed(2)} m/s, Kuroshio ${kuroshio.toFixed(2)} m/s`);
    expect(gulf).toBeGreaterThan(0.7);
    expect(kuroshio).toBeGreaterThan(0.8);
    expect(c.stats.globalPrecipMm).toBeGreaterThan(950);
    expect(c.stats.globalPrecipMm).toBeLessThan(1100);
    expect(c.stats.pMinusEError).toBeLessThan(0.03);
  });

  it('has a physically structured cloud field', () => {
    const global = boxMean(c.cloud, -90, 90, -180, 180);
    const itcz = boxMean(c.cloud, 0, 10, -180, 180);
    const sahara = boxMean(c.cloud, 15, 30, -10, 30, 'land');
    const stormS = boxMean(c.cloud, -60, -45, -180, 180, 'ocean');
    const stormN = boxMean(c.cloud, 45, 60, -180, 180, 'ocean');
    const peru = boxMean(c.cloud, -25, -8, -90, -75, 'ocean');
    const subtropS = boxMean(c.cloud, -30, -15, -150, -100, 'ocean');
    console.log(`Earth clouds: global ${global.toFixed(2)} ITCZ ${itcz.toFixed(2)} Sahara ${sahara.toFixed(2)} storm N/S ${stormN.toFixed(2)}/${stormS.toFixed(2)} Peru Sc ${peru.toFixed(2)} SE Pacific high ${subtropS.toFixed(2)}`);
    expect(global).toBeGreaterThan(0.52);
    expect(global).toBeLessThan(0.7);
    expect(itcz).toBeGreaterThan(sahara + 0.35);
    expect(stormS).toBeGreaterThan(0.7);
    expect(stormN).toBeGreaterThan(0.65);
    expect(sahara).toBeLessThan(0.25);
  });
});
