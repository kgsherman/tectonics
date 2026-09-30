import { describe, expect, it } from 'vitest';
import { gridIndexAt } from '../src/core/grid';
import {
  buildEarthClimateInput, buildEarthSamples, EARTH_KOPPEN_GROUP_TARGETS, EARTH_ZONAL_MEAN_TEMP, REFERENCE_CITIES,
} from '../src/climate/earthInput';
import { KOPPEN_CLASSES, koppenIdFromCode } from '../src/climate/koppen';

const DEG = Math.PI / 180;
const W = 360;
const H = 180;
const earth = buildEarthClimateInput(W, H);
const at = (latDeg: number, lonDeg: number): number => earth.elev[gridIndexAt(W, H, latDeg * DEG, lonDeg * DEG)];

describe('buildEarthClimateInput', () => {
  it('returns a well-formed, finite ClimateInput', () => {
    expect(earth.w).toBe(W);
    expect(earth.h).toBe(H);
    expect(earth.elev.length).toBe(W * H);
    expect(earth.landFraction?.length).toBe(W * H);
    for (let i = 0; i < W * H; i++) {
      expect(Number.isFinite(earth.elev[i])).toBe(true);
      const lf = earth.landFraction![i];
      expect(lf >= 0 && lf <= 1).toBe(true);
      // Land (lf ≥ 0.5) ⇔ elev > 0, so either land test gives the same mask.
      expect(earth.elev[i] > 0).toBe(lf >= 0.5);
    }
  });

  it('has an Earth-like area-weighted land fraction', () => {
    let a = 0, l = 0;
    for (let r = 0; r < H; r++) {
      const wgt = Math.cos((90 - (r + 0.5) * (180 / H)) * DEG);
      for (let c = 0; c < W; c++) {
        a += wgt;
        l += wgt * earth.landFraction![r * W + c];
      }
    }
    const f = l / a;
    expect(f).toBeGreaterThan(0.27);
    expect(f).toBeLessThan(0.31);
  });

  it('places major relief correctly', () => {
    expect(at(32, 88)).toBeGreaterThan(4000); // Tibetan Plateau
    expect(at(-17, -68)).toBeGreaterThan(3500); // Altiplano
    let himalaya = 0; // highest 1° cell along the central Himalaya
    for (let lon = 80.5; lon < 92; lon++) for (let lat = 27.5; lat < 30; lat++) himalaya = Math.max(himalaya, at(lat, lon));
    expect(himalaya).toBeGreaterThan(5000);
    expect(at(28.5, 87)).toBeGreaterThan(4500); // Everest–Tingri
    const sahara = at(23, 10);
    expect(sahara).toBeGreaterThan(0);
    expect(sahara).toBeLessThan(1200);
    expect(at(0, -150)).toBeLessThan(-3000); // mid-Pacific
    expect(at(72, -40)).toBeGreaterThan(1500); // Greenland ice sheet
    expect(at(-80, 100)).toBeGreaterThan(2800); // East Antarctic ice sheet
    expect(at(-3, -60)).toBeLessThan(300); // Amazon basin
    expect(at(60, 75)).toBeLessThan(250); // West Siberian Plain
    expect(at(46.5, 9)).toBeGreaterThan(1500); // Alps
    expect(at(39, -106)).toBeGreaterThan(2500); // Colorado Rockies
    expect(at(19.4, -99.1)).toBeGreaterThan(1800); // Mexican Plateau / Mexico City
    expect(at(9, 38.7)).toBeGreaterThan(1800); // Ethiopian Highlands
    expect(at(55, -30)).toBeLessThan(-1500); // North Atlantic
  });

  it('puts every reference city on (or next to) a land cell', () => {
    const offLand: string[] = [];
    for (const city of REFERENCE_CITIES) {
      const i = gridIndexAt(W, H, city.lat * DEG, city.lon * DEG);
      const r = Math.floor(i / W), c = i % W;
      let ok = false;
      for (let dr = -1; dr <= 1 && !ok; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= H) continue;
        for (let dc = -1; dc <= 1 && !ok; dc++) {
          if (earth.landFraction![rr * W + ((c + dc + W) % W)] >= 0.5) ok = true;
        }
      }
      if (!ok) offLand.push(city.name);
    }
    expect(offLand).toEqual([]);
  });

  it('is deterministic and returns independent copies', () => {
    const a = buildEarthClimateInput(90, 45);
    const b = buildEarthClimateInput(90, 45);
    expect(Array.from(a.elev)).toEqual(Array.from(b.elev));
    a.elev[0] = 12345;
    expect(buildEarthClimateInput(90, 45).elev[0]).not.toBe(12345);
  });

  it('handles other grid sizes (land fraction stays Earth-like)', () => {
    for (const [w, h] of [[180, 90], [720, 360]] as const) {
      const e = buildEarthClimateInput(w, h);
      let a = 0, l = 0;
      for (let r = 0; r < h; r++) {
        const wgt = Math.cos((90 - (r + 0.5) * (180 / h)) * DEG);
        for (let c = 0; c < w; c++) {
          a += wgt;
          l += wgt * e.landFraction![r * w + c];
        }
      }
      expect(l / a).toBeGreaterThan(0.27);
      expect(l / a).toBeLessThan(0.31);
    }
  });

  it('rasterizes the antimeridian and the south pole correctly', () => {
    const s = buildEarthSamples(1440, 720, false);
    const land = (lat: number, lon: number): number => {
      const r = Math.min(719, Math.floor(((90 - lat) / 180) * 720));
      const c = Math.floor(((lon + 180) / 360) * 1440) % 1440;
      return s.land[r * 1440 + c];
    };
    expect(land(-89.9, 0)).toBe(1); // Antarctica covers the pole
    expect(land(-86, 179.9)).toBe(1); // (the Ross Ice Shelf itself is not land in Natural Earth)
    expect(land(-86, -179.9)).toBe(1);
    expect(land(66, 179.9)).toBe(1); // Chukotka on both sides of 180°
    expect(land(66, -179.9)).toBe(1);
    expect(land(-17.9, 178.1)).toBe(1); // Viti Levu (Fiji)
    expect(land(0, -179.9)).toBe(0); // open Pacific
    expect(land(89.9, 0)).toBe(0); // Arctic Ocean
    expect(land(42, 50.5)).toBe(0); // Caspian Sea is water
  });
});

describe('REFERENCE_CITIES', () => {
  it('uses valid Köppen codes and covers every group', () => {
    const groups = new Set<string>();
    for (const c of REFERENCE_CITIES) {
      const id = koppenIdFromCode(c.koppen);
      expect(id, c.name).toBeGreaterThan(0);
      groups.add(KOPPEN_CLASSES[id].group);
      expect(Math.abs(c.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(c.lon)).toBeLessThanOrEqual(180);
    }
    expect([...groups].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(REFERENCE_CITIES.length).toBeGreaterThanOrEqual(55);
    expect(new Set(REFERENCE_CITIES.map((c) => c.name)).size).toBe(REFERENCE_CITIES.length);
  });

  it('exposes Earth reference targets', () => {
    const t = EARTH_KOPPEN_GROUP_TARGETS;
    expect(t.A + t.B + t.C + t.D + t.E).toBe(100);
    expect(EARTH_ZONAL_MEAN_TEMP.length).toBe(18);
  });
});
