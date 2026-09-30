import { describe, expect, it } from 'vitest';
import { LAPSE_RATE, SECONDS_PER_MONTH } from '../src/core/constants';
import { gridLat } from '../src/core/grid';
import { erfc, positiveDegreeDaysPerDay, computeSnowCover } from '../src/climate/hydroSnow';
import { cloudCover } from '../src/climate/hydroCloud';
import { HYDRO_TUNING } from '../src/climate/hydroTuning';
import { ImplicitDiffusion } from '../src/climate/moistureDiffusion';
import { blurSphere, divergence, globalMean, gradient, locateBilinear, makeHydroGrid } from '../src/climate/moistureGrid';
import { allocStencil, applyStencil, buildDepartureStencil } from '../src/climate/moistureStencil';
import { hamonPet, monthDayLength, satSpecificHumidity, saturationColumnWater } from '../src/climate/moistureThermo';
import { substepsFor } from '../src/climate/moistureColumn';
import { sampleClimateAt } from '../src/climate/sample';
import { KOPPEN_CLASSES, classifyKoppen } from '../src/climate/koppen';
import { zonalClimate } from './helpers/fixtures';

const DEG = Math.PI / 180;

function pseudoRandom(n: number, seed = 1): Float64Array {
  const a = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    a[i] = s / 4294967296;
  }
  return a;
}

describe('hydrology thermodynamics', () => {
  it('saturation column water and humidity have Earth-like magnitudes', () => {
    expect(saturationColumnWater(25, 2200)).toBeGreaterThan(45);
    expect(saturationColumnWater(25, 2200)).toBeLessThan(56);
    expect(saturationColumnWater(0, 2200)).toBeGreaterThan(8);
    expect(saturationColumnWater(0, 2200)).toBeLessThan(11);
    expect(saturationColumnWater(-40, 2200)).toBeLessThan(0.5);
    expect(saturationColumnWater(-200, 2200)).toBeGreaterThan(0);
    expect(Number.isFinite(saturationColumnWater(-200, 2200))).toBe(true);
    expect(satSpecificHumidity(20)).toBeCloseTo(0.0147, 3);
  });

  it('saturation specific humidity stays in [0, 1] and non-decreasing up to boiling and beyond', () => {
    let prev = 0;
    for (let t = -100; t <= 250; t += 0.5) {
      const q = satSpecificHumidity(t);
      expect(q).toBeGreaterThanOrEqual(prev);
      expect(q).toBeLessThanOrEqual(1);
      prev = q;
    }
  });

  it('sink sub-steps stay within the Uint8 counter', () => {
    expect(substepsFor(1, 1 / 86400, 15, 0.78, 28800, 1, 24)).toBeGreaterThanOrEqual(1);
    expect(substepsFor(1e6, 1, 15, 0.78, 28800, 1e-3, 1000)).toBe(255);
    expect(substepsFor(0, 1, 15, 0.78, 28800, 1, 0)).toBe(1);
  });

  it('Hamon PET is zero below freezing and a few mm/day when warm', () => {
    expect(hamonPet(-5, 12, 2)).toBe(0);
    expect(hamonPet(0, 12, 2)).toBe(0);
    const mmDay = hamonPet(25, 12, 2) * 86400;
    expect(mmDay).toBeGreaterThan(3);
    expect(mmDay).toBeLessThan(6);
    expect(hamonPet(1, 12, 2)).toBeLessThan(hamonPet(2, 12, 2));
  });

  it('day length: 12 h at the equator, polar night / midnight sun at the solstices', () => {
    expect(monthDayLength(0, 5, 23.44 * DEG)).toBeCloseTo(12, 5);
    expect(monthDayLength(80 * DEG, 5, 23.44 * DEG)).toBeCloseTo(24, 5);
    expect(monthDayLength(80 * DEG, 11, 23.44 * DEG)).toBeCloseTo(0, 5);
    expect(monthDayLength(45 * DEG, 5, 0)).toBeCloseTo(12, 5);
    const d90 = monthDayLength(10 * DEG, 5, 90 * DEG);
    expect(Number.isFinite(d90)).toBe(true);
  });
});

describe('hydrology grid operators', () => {
  const g = makeHydroGrid(72, 36);

  it('row areas sum to one', () => {
    let s = 0;
    for (let r = 0; r < g.h; r++) s += g.rowArea[r] * g.w;
    expect(s).toBeCloseTo(1, 12);
  });

  it('Gaussian smoothing preserves constants and reduces variance', () => {
    const c = new Float64Array(g.n).fill(3.5);
    const b = blurSphere(g, c, 400);
    for (let i = 0; i < g.n; i++) expect(b[i]).toBeCloseTo(3.5, 10);
    const rnd = pseudoRandom(g.n);
    const s = blurSphere(g, rnd, 400);
    const v = (a: ArrayLike<number>) => {
      const m = globalMean(g, a);
      let q = 0;
      for (let r = 0; r < g.h; r++) for (let k = 0; k < g.w; k++) q += (a[r * g.w + k] - m) ** 2 * g.rowArea[r];
      return q;
    };
    expect(v(s)).toBeLessThan(0.3 * v(rnd));
  });

  it('divergence integrates to zero and vanishes for solid-body rotation', () => {
    const u = pseudoRandom(g.n, 3).map((x) => 20 * (x - 0.5));
    const v = pseudoRandom(g.n, 4).map((x) => 20 * (x - 0.5));
    const div = new Float64Array(g.n);
    divergence(g, u, v, 0, div);
    let s = 0;
    let q = 0;
    for (let r = 0; r < g.h; r++) {
      for (let c = 0; c < g.w; c++) {
        s += div[r * g.w + c] * g.rowArea[r];
        q += Math.abs(div[r * g.w + c]) * g.rowArea[r];
      }
    }
    expect(Math.abs(s)).toBeLessThan(1e-12 * Math.max(1, q) + 1e-18);
    const ur = new Float64Array(g.n);
    for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) ur[r * g.w + c] = 10 * g.cosLat[r];
    divergence(g, ur, new Float64Array(g.n), 0, div);
    for (let i = 0; i < g.n; i++) expect(Math.abs(div[i])).toBeLessThan(1e-15);
  });

  it('gradient of a linear-in-latitude field points north with the right magnitude', () => {
    const f = new Float64Array(g.n);
    for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) f[r * g.w + c] = 1000 * g.lat[r];
    const gx = new Float64Array(g.n);
    const gy = new Float64Array(g.n);
    gradient(g, f, gx, gy);
    const i = 18 * g.w + 5;
    expect(gx[i]).toBeCloseTo(0, 12);
    expect(gy[i]).toBeCloseTo(1000 / 6.371e6, 9);
  });

  it('bilinear location weights sum to one, including across the poles', () => {
    const idx = new Int32Array(4);
    const wt = new Float64Array(4);
    for (const [la, lo] of [[0.1, 0.2], [89.9 * DEG, 1], [-89.9 * DEG, -3], [0, Math.PI], [0, -Math.PI]]) {
      locateBilinear(g, la, lo, idx, wt, 0);
      expect(wt[0] + wt[1] + wt[2] + wt[3]).toBeCloseTo(1, 12);
      for (let k = 0; k < 4; k++) {
        expect(idx[k]).toBeGreaterThanOrEqual(0);
        expect(idx[k]).toBeLessThan(g.n);
      }
    }
  });
});

describe('semi-Lagrangian stencils', () => {
  const g = makeHydroGrid(72, 36);

  it('zero wind gives the identity', () => {
    const z = new Float32Array(g.n);
    const s = allocStencil(g.n);
    buildDepartureStencil(g, z, z, 0, 3600, 2, s);
    const f = pseudoRandom(g.n, 9);
    const out = new Float64Array(g.n);
    applyStencil(s, f, out, g.n);
    for (let i = 0; i < g.n; i++) expect(out[i]).toBeCloseTo(f[i], 6);
  });

  it('solid-body rotation shifts a field by the rotation angle (in 3D, through the poles)', () => {
    // Rigid rotation about the x axis (flow crosses both poles): u = Ω R (…) from ω × p.
    const w = 72, h = 36;
    const u = new Float32Array(w * h);
    const v = new Float32Array(w * h);
    const omega = 2e-6; // rad/s
    const R = 6.371e6;
    for (let r = 0; r < h; r++) {
      const la = gridLat(h, r);
      for (let c = 0; c < w; c++) {
        const lo = -Math.PI + ((c + 0.5) * 2 * Math.PI) / w;
        const p = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
        const vel = [0, -omega * p[2], omega * p[1]]; // ω x̂ × p
        const e = [-Math.sin(lo), Math.cos(lo), 0];
        const nn = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
        u[r * w + c] = R * (vel[0] * e[0] + vel[1] * e[1] + vel[2] * e[2]);
        v[r * w + c] = R * (vel[0] * nn[0] + vel[1] * nn[1] + vel[2] * nn[2]);
      }
    }
    const dt = 6 * 3600;
    const s = allocStencil(g.n);
    buildDepartureStencil(g, u, v, 0, dt, 2, s);
    // Advect the smooth field f = z (sin lat): exact result is z rotated back by angle ω dt about x.
    const f = new Float64Array(g.n);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) f[r * w + c] = Math.sin(gridLat(h, r));
    const out = new Float64Array(g.n);
    applyStencil(s, f, out, g.n);
    const a = omega * dt;
    let maxErr = 0;
    for (let r = 0; r < h; r++) {
      const la = gridLat(h, r);
      for (let c = 0; c < w; c++) {
        const lo = -Math.PI + ((c + 0.5) * 2 * Math.PI) / w;
        const y = Math.cos(la) * Math.sin(lo);
        const z = Math.sin(la);
        // Departure point = R_x(−a) p ⇒ its z = −sin(a)·y + cos(a)·z.
        const exact = -Math.sin(a) * y + Math.cos(a) * z;
        maxErr = Math.max(maxErr, Math.abs(out[r * w + c] - exact));
      }
    }
    // Bilinear interpolation error of a unit-amplitude field at 5° spacing is ~1e-3.
    expect(maxErr).toBeLessThan(0.002);
  });
});

describe('implicit eddy diffusion', () => {
  const g = makeHydroGrid(72, 36);
  const K = new Float64Array(g.n).map((_, i) => 5e5 + 1e6 * ((i * 7919) % 13) / 13);

  it('conserves area-weighted mass, keeps constants, and smooths', () => {
    const d = new ImplicitDiffusion(g);
    d.setup(K, 6 * 3600);
    const c = new Float64Array(g.n).fill(2);
    d.apply(c);
    for (let i = 0; i < g.n; i++) expect(c[i]).toBeCloseTo(2, 9);
    const f = pseudoRandom(g.n, 5);
    const m0 = globalMean(g, f);
    const f0 = Float64Array.from(f);
    for (let k = 0; k < 10; k++) d.apply(f);
    expect(globalMean(g, f)).toBeCloseTo(m0, 12);
    let v0 = 0;
    let v1 = 0;
    for (let i = 0; i < g.n; i++) {
      v0 += (f0[i] - m0) ** 2;
      v1 += (f[i] - m0) ** 2;
    }
    expect(v1).toBeLessThan(0.5 * v0);
    for (let i = 0; i < g.n; i++) {
      expect(f[i]).toBeGreaterThanOrEqual(-1e-9);
      expect(f[i]).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('snowpack and clouds', () => {
  it('erfc and positive degree-days behave', () => {
    expect(erfc(0)).toBeCloseTo(1, 6);
    expect(erfc(1)).toBeCloseTo(0.157299, 5);
    expect(erfc(-1)).toBeCloseTo(1.842701, 5);
    expect(positiveDegreeDaysPerDay(20, 4.5)).toBeCloseTo(20, 3);
    expect(positiveDegreeDaysPerDay(-20, 4.5)).toBeLessThan(1e-4);
    expect(positiveDegreeDaysPerDay(0, 4.5)).toBeCloseTo(4.5 / Math.sqrt(2 * Math.PI), 6);
  });

  it('accumulates in cold months, melts in warm ones, 0 when always warm, on ice only at sea', () => {
    const n = 3;
    const temp = new Float32Array(12 * n);
    const precip = new Float32Array(12 * n).fill(60);
    const seaIce = new Float32Array(12 * n);
    for (let m = 0; m < 12; m++) {
      temp[m * n + 0] = 15 * Math.cos((2 * Math.PI * (m - 6.5)) / 12) - 2; // continental: cold winters
      temp[m * n + 1] = 25; // tropical
      temp[m * n + 2] = -15; // sea ice, half covered
      seaIce[m * n + 2] = 0.5;
    }
    const out = new Float32Array(12 * n);
    computeSnowCover({ n, temp, precip, land: Uint8Array.from([1, 1, 0]), seaIce }, HYDRO_TUNING, out);
    expect(out[0 * n]).toBeGreaterThan(0.9); // January
    expect(out[6 * n]).toBeLessThan(0.05); // July
    for (let m = 0; m < 12; m++) expect(out[m * n + 1]).toBe(0);
    expect(out[0 * n + 2]).toBeGreaterThan(0.45);
    expect(out[0 * n + 2]).toBeLessThanOrEqual(0.5);
  });

  it('cloud cover rises with RH and precipitation and stays in [0, 1]', () => {
    const t = HYDRO_TUNING;
    expect(cloudCover(0.1, 0, 0, 1, t)).toBeLessThan(0.05);
    expect(cloudCover(0.9, 10, 0, 1, t)).toBeGreaterThan(0.8);
    expect(cloudCover(0.5, 0, 8, 1, t)).toBeGreaterThan(cloudCover(0.5, 0, 0, 1, t));
    expect(cloudCover(2, 1000, 100, 1, t)).toBeLessThanOrEqual(1);
  });
});

describe('sampleClimateAt', () => {
  const c = zonalClimate(90, 45);
  const n = c.w * c.h;

  it('returns the nearest cell and its stored class without an override', () => {
    const lat = 10 * DEG;
    const lon = 5 * DEG;
    const s = sampleClimateAt(c, lat, lon, 3);
    const r = Math.round((Math.PI / 2 - lat) / (Math.PI / c.h) - 0.5);
    const col = Math.round((lon + Math.PI) / ((2 * Math.PI) / c.w) - 0.5);
    expect(s.index).toBe(r * c.w + col);
    expect(s.koppen).toBe(c.koppenAll[s.index]);
    expect(s.temp[3]).toBe(c.temp[3 * n + s.index]);
    expect(s.sst).toBe(c.sst[3 * n + s.index]);
    let pa = 0;
    for (let m = 0; m < 12; m++) pa += c.precip[m * n + s.index];
    expect(s.precipAnnual).toBeCloseTo(pa, 3);
  });

  it('lapse-corrects to an elevation override and reclassifies', () => {
    const lat = 5 * DEG;
    const lon = 0;
    const base = sampleClimateAt(c, lat, lon);
    const hi = sampleClimateAt(c, lat, lon, -1, base.elev + 4000);
    const ref = Math.max(0, base.elev - c.params.seaLevel);
    const dT = LAPSE_RATE * (ref - (base.elev + 4000 - c.params.seaLevel));
    for (let m = 0; m < 12; m++) expect(hi.temp[m]).toBeCloseTo(base.temp[m] + dT, 4);
    expect(hi.koppen).toBe(classifyKoppen(hi.temp, hi.precip, false));
    expect(hi.tempAnnual).toBeCloseTo(base.tempAnnual + dT, 4);
    // Annual mean for month < 0.
    let cl = 0;
    for (let m = 0; m < 12; m++) cl += c.cloud[m * n + base.index] / 12;
    expect(base.cloud).toBeCloseTo(cl, 5);
  });

  it('reclassifies with the cell hemisphere (equator row of an odd-height grid)', () => {
    // 45 rows: row 22 spans 2°S–2°N and is northern for the orchestrator (row < h/2). A constant
    // 15 °C with a June–August dry season is Cs in the north and Cw in the south.
    const cc = zonalClimate(90, 45);
    const nn = cc.w * cc.h;
    const col = 10;
    const i = 22 * cc.w + col;
    const t = new Float32Array(12).fill(15);
    const p = new Float32Array(12);
    for (let m = 0; m < 12; m++) {
      p[m] = m >= 5 && m <= 7 ? 5 : 150;
      cc.temp[m * nn + i] = t[m];
      cc.precip[m * nn + i] = p[m];
    }
    cc.koppenAll[i] = classifyKoppen(t, p, false);
    const lon = -Math.PI + ((col + 0.5) * 2 * Math.PI) / cc.w;
    const codes = [1, -1].map((la) => {
      const s = sampleClimateAt(cc, la * DEG, lon, -1, Math.max(cc.params.seaLevel, cc.elev[i]) + 1);
      expect(s.index).toBe(i);
      return KOPPEN_CLASSES[s.koppen].code;
    });
    expect(codes[0]).toBe(KOPPEN_CLASSES[cc.koppenAll[i]].code);
    expect(codes[1]).toBe(codes[0]);
    expect(codes[0].startsWith('Cs')).toBe(true);
  });

  it('reuses the output object', () => {
    const out = sampleClimateAt(c, 0, 0);
    const again = sampleClimateAt(c, 0.5, 1, 2, undefined, out);
    expect(again).toBe(out);
    expect(again.temp).toBe(out.temp);
  });
});

describe('hydrology units', () => {
  it('SECONDS_PER_MONTH converts kg m⁻² s⁻¹ to mm/month', () => {
    expect(SECONDS_PER_MONTH / 86400).toBeCloseTo(30.44, 2);
  });
});
