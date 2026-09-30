import { describe, expect, it } from 'vitest';
import { buildMeshGridMap, gridLat, meshToGrid, resampleGrid } from '../src/core/grid';
import { quatFromAxisAngle, quatToMat3 } from '../src/core/math3';
import type { ClimateResult, LayerId, PaintOptions, PaintSources, Quat, SphereMesh, WorldSnapshot } from '../src/core/types';
import { CRUST_CONTINENTAL } from '../src/core/types';
import { KOPPEN_CLASSES, koppenIdFromCode } from '../src/climate/koppen';
import { CM_TEMP } from '../src/render/colormaps';
import { LAYER_LABELS, PaintCache, getLegend, paintHeightMap, paintLayer, paintOverlay } from '../src/render/paint';
import { heightFieldKey } from '../src/render/terrain';
import { smallMesh, syntheticSnapshot, zonalClimate } from './helpers/fixtures';

const LAYERS = Object.keys(LAYER_LABELS) as LayerId[];

function opts(over: Partial<PaintOptions> = {}): PaintOptions {
  return { width: 512, height: 256, month: 6, seaLevel: 0, hillshade: true, seed: 5, quality: 'full', ...over };
}

/** Climate on the 2° grid whose land roughly matches the snapshot. */
function climateFor(mesh: SphereMesh, snap: WorldSnapshot, w = 180, h = 90): ClimateResult {
  const map = buildMeshGridMap(mesh, 4 * w, 4 * h);
  const e = resampleGrid(meshToGrid(map, snap.elev), 4 * w, 4 * h, w, h);
  return zonalClimate(w, h, e);
}

const mesh = smallMesh(20000);
const snap = syntheticSnapshot(mesh, 3);
const climate = climateFor(mesh, snap);
const src: PaintSources = { mesh, snapshot: snap, climate };

describe('paintLayer basics', () => {
  const cache = new PaintCache();
  it('paints every layer, opaque, right size, with and without climate / snapshot', () => {
    for (const sources of [src, { mesh, snapshot: snap, climate: null }, { mesh, snapshot: null, climate: null }]) {
      for (const layer of LAYERS) {
        for (const quality of ['preview', 'full'] as const) {
          const o = opts({ quality, width: 256, height: 128 });
          const r = paintLayer(layer, sources, o, cache);
          expect(r.width).toBe(256);
          expect(r.height).toBe(128);
          expect(r.rgba.length).toBe(256 * 128 * 4);
          let opaque = true;
          for (let p = 3; p < r.rgba.length; p += 4) if (r.rgba[p] !== 255) { opaque = false; break; }
          expect(opaque).toBe(true);
        }
      }
    }
  });

  it('heightMap is filled for satellite/elevation, equals paintHeightMap and is a fresh finite copy', () => {
    const o = opts();
    const hm = paintHeightMap(src, o, cache);
    for (const layer of ['satellite', 'elevation'] as const) {
      const r = paintLayer(layer, src, o, cache);
      expect(r.heightMap).toBeDefined();
      expect(r.heightMap).not.toBe(hm);
      expect(Array.from(r.heightMap!)).toEqual(Array.from(hm));
    }
    expect(paintLayer('plates', src, o, cache).heightMap).toBeUndefined();
    expect(hm.every(Number.isFinite)).toBe(true);
    const again = paintHeightMap(src, o, cache);
    expect(again).not.toBe(hm);
    again[0] = 12345;
    expect(paintHeightMap(src, o, cache)[0]).not.toBe(12345);
  });

  it('is deterministic across independent caches (no NaN-black pixels)', () => {
    for (const layer of ['satellite', 'koppen', 'currents', 'plates'] as const) {
      const a = paintLayer(layer, src, opts(), new PaintCache());
      const b = paintLayer(layer, src, opts(), new PaintCache());
      expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
    }
    const sat = paintLayer('satellite', src, opts(), new PaintCache()).rgba;
    let black = 0;
    for (let p = 0; p < sat.length; p += 4) if (sat[p] === 0 && sat[p + 1] === 0 && sat[p + 2] === 0) black++;
    expect(black).toBe(0);
  });

  it('rejects invalid options and mismatched sources', () => {
    expect(() => paintLayer('satellite', src, opts({ width: 0 }))).toThrow();
    expect(() => paintLayer('satellite', src, opts({ seaLevel: NaN }))).toThrow();
    expect(() => paintLayer('satellite', { mesh: smallMesh(4000), snapshot: snap, climate }, opts())).toThrow();
  });

  it('has a legend for every layer with ascending gradient stops', () => {
    for (const layer of LAYERS) {
      const lg = getLegend(layer, src, opts());
      expect(lg).not.toBeNull();
      if (lg!.kind === 'gradient') {
        expect(lg!.stops.length).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < lg!.stops.length; i++) expect(lg!.stops[i].value).toBeGreaterThan(lg!.stops[i - 1].value);
      } else if (layer !== 'plates' || snap) {
        expect(lg!.items.length).toBeGreaterThan(0);
      }
    }
    const kl = getLegend('koppen', src, opts());
    expect(kl!.kind).toBe('categorical');
  });
});

describe('land / sea rule', () => {
  const cache = new PaintCache();
  it('Köppen colours land pixels exactly where heightMap > seaLevel', () => {
    for (const seaLevel of [0, 300]) {
      const o = opts({ hillshade: false, seaLevel });
      const hm = paintHeightMap(src, o, cache);
      const rgba = paintLayer('koppen', src, o, cache).rgba;
      const land = new Set(KOPPEN_CLASSES.slice(1).map((k) => (k.color[0] << 16) | (k.color[1] << 8) | k.color[2]));
      let mismatch = 0;
      for (let p = 0; p < hm.length; p++) {
        const isLandColor = land.has((rgba[4 * p] << 16) | (rgba[4 * p + 1] << 8) | rgba[4 * p + 2]);
        if (isLandColor !== hm[p] > seaLevel) mismatch++;
      }
      expect(mismatch).toBe(0);
    }
  });

  it('satellite paints ocean colours below sea level and non-ocean colours above (ice-free latitudes)', () => {
    const o = opts({ quality: 'preview', month: 3 });
    const hm = paintHeightMap(src, o, cache);
    const rgba = paintLayer('satellite', src, o, cache).rgba;
    let bad = 0, n = 0;
    for (let r = 0; r < o.height; r++) {
      if (Math.abs(gridLat(o.height, r)) > (40 * Math.PI) / 180) continue;
      for (let c = 0; c < o.width; c++) {
        const p = r * o.width + c;
        // Pixels right on the coastline are anti-aliased (blended with their other-class
        // neighbours by sub-pixel coverage): only the land/sea colour rule away from it is tested.
        const land = hm[p] > 0;
        const nb = [r * o.width + ((c + 1) % o.width), r * o.width + ((c + o.width - 1) % o.width), p - o.width, p + o.width];
        if (nb.some((q) => q >= 0 && q < hm.length && hm[q] > 0 !== land)) continue;
        const bluish = rgba[4 * p + 2] > rgba[4 * p] + 20;
        if (hm[p] <= 0 !== bluish) bad++;
        n++;
      }
    }
    expect(bad / n).toBeLessThan(0.002);
  });
});

/** Uniform continental world (flat base, no orogeny) so only procedural detail varies. */
function flatWorld(rotations: Quat[], split: 'one' | 'hemispheres', id: number): WorldSnapshot {
  const n = mesh.n;
  const plate = new Int16Array(n);
  if (split === 'hemispheres') for (let i = 0; i < n; i++) plate[i] = mesh.xyz[3 * i + 2] >= 0 ? 1 : 0;
  const base = syntheticSnapshot(mesh, 3, 2);
  return {
    ...base,
    id,
    plate,
    elev: new Float32Array(n).fill(600),
    crust: new Uint8Array(n).fill(CRUST_CONTINENTAL),
    age: new Float32Array(n).fill(1000),
    orogeny: new Float32Array(n),
    boundary: new Uint8Array(n),
    plates: base.plates.slice(0, rotations.length).map((p, k) => ({ ...p, rotation: rotations[k] })),
  };
}

describe('plate-frame anchored detail', () => {
  const W = 512, H = 256;
  const o = opts({ width: W, height: H });
  const I: Quat = [0, 0, 0, 1];

  it('detail pattern shifts exactly with a plate rotated about the pole', () => {
    const k = 37;
    const qz = quatFromAxisAngle([0, 0, 1], (2 * Math.PI * k) / W);
    const cache = new PaintCache();
    const h0 = paintHeightMap({ mesh, snapshot: flatWorld([I], 'one', 101), climate: null }, o, cache);
    const h1 = paintHeightMap({ mesh, snapshot: flatWorld([qz], 'one', 102), climate: null }, o, cache);
    let maxDiff = 0, spread = 0;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const a = h1[r * W + ((c + k) % W)], b = h0[r * W + c];
        maxDiff = Math.max(maxDiff, Math.abs(a - b));
        spread = Math.max(spread, Math.abs(b - 600));
      }
    }
    expect(spread).toBeGreaterThan(50); // there is detail to follow
    expect(maxDiff).toBeLessThan(0.05);
  });

  it('only the rotated plate carries its detail along (the other plate stays)', () => {
    const k = 21;
    const qz = quatFromAxisAngle([0, 0, 1], (2 * Math.PI * k) / W);
    const cache = new PaintCache();
    const h0 = paintHeightMap({ mesh, snapshot: flatWorld([I, I], 'hemispheres', 201), climate: null }, o, cache);
    const h1 = paintHeightMap({ mesh, snapshot: flatWorld([I, qz], 'hemispheres', 202), climate: null }, o, cache);
    const band = 10; // rows near the equator blend both plates
    let north = 0, south = 0;
    for (let r = 0; r < H; r++) {
      if (Math.abs(r - H / 2) < band) continue;
      for (let c = 0; c < W; c++) {
        if (r < H / 2) north = Math.max(north, Math.abs(h1[r * W + ((c + k) % W)] - h0[r * W + c]));
        else south = Math.max(south, Math.abs(h1[r * W + c] - h0[r * W + c]));
      }
    }
    expect(north).toBeLessThan(0.05);
    expect(south).toBeLessThan(0.05);
  });

  it('follows an arbitrary-axis rotation (resampled comparison)', () => {
    const q = quatFromAxisAngle([0.3, -0.5, 0.8], 0.45);
    const cache = new PaintCache();
    const h0 = paintHeightMap({ mesh, snapshot: flatWorld([I], 'one', 301), climate: null }, o, cache);
    const h1 = paintHeightMap({ mesh, snapshot: flatWorld([q], 'one', 302), climate: null }, o, cache);
    const m = quatToMat3(q);
    // Moved pattern: h1(p) = h0(Rᵀp); the unmoved alternative h0(p) must correlate far worse.
    let sxy = 0, sxx = 0, syy = 0, sx = 0, sy = 0, szz = 0, sxz = 0, sz = 0, cnt = 0;
    for (let r = 8; r < H - 8; r += 2) {
      const la = gridLat(H, r);
      for (let c = 0; c < W; c += 2) {
        const lo = -Math.PI + ((c + 0.5) * 2 * Math.PI) / W;
        const x = Math.cos(la) * Math.cos(lo), y = Math.cos(la) * Math.sin(lo), z = Math.sin(la);
        const X = m[0] * x + m[3] * y + m[6] * z, Y = m[1] * x + m[4] * y + m[7] * z, Z = m[2] * x + m[5] * y + m[8] * z;
        const la2 = Math.asin(Math.max(-1, Math.min(1, Z))), lo2 = Math.atan2(Y, X);
        const fr = ((Math.PI / 2 - la2) / Math.PI) * H - 0.5, fc = (((lo2 + Math.PI) / (2 * Math.PI)) * W - 0.5 + W) % W;
        const r0 = Math.max(0, Math.min(H - 2, Math.floor(fr))), c0 = Math.floor(fc) % W, c1 = (c0 + 1) % W;
        const tr = Math.max(0, Math.min(1, fr - r0)), tc = fc - Math.floor(fc);
        const v0 = h0[r0 * W + c0] * (1 - tc) + h0[r0 * W + c1] * tc, v1 = h0[(r0 + 1) * W + c0] * (1 - tc) + h0[(r0 + 1) * W + c1] * tc;
        const moved = v0 * (1 - tr) + v1 * tr, got = h1[r * W + c], still = h0[r * W + c];
        sx += moved; sy += got; sxx += moved * moved; syy += got * got; sxy += moved * got;
        sz += still; szz += still * still; sxz += still * got;
        cnt++;
      }
    }
    const corr = (a: number, b: number, aa: number, bb: number, ab: number) =>
      (ab / cnt - (a / cnt) * (b / cnt)) / Math.sqrt((aa / cnt - (a / cnt) ** 2) * (bb / cnt - (b / cnt) ** 2));
    expect(corr(sx, sy, sxx, syy, sxy)).toBeGreaterThan(0.9);
    expect(corr(sz, sy, szz, syy, sxz)).toBeLessThan(0.3);
  });
});

describe('resolution and quality consistency', () => {
  it('preview and full produce the same coastlines; octaves match across resolutions', () => {
    const cache = new PaintCache();
    const lo = paintHeightMap(src, opts({ quality: 'preview' }), cache);
    const hi = paintHeightMap(src, opts({ quality: 'full' }), cache);
    let same = 0;
    for (let p = 0; p < lo.length; p++) if (lo[p] > 0 === hi[p] > 0) same++;
    expect(same / lo.length).toBe(1);
    const big = paintHeightMap(src, opts({ width: 1024, height: 512 }), cache);
    const down = resampleGrid(big, 1024, 512, 512, 256);
    let agree = 0;
    for (let p = 0; p < lo.length; p++) if (lo[p] > 0 === down[p] > 0) agree++;
    // The coastline now carries crisp, band-limited detail down to ~2 px (whiter coast noise), which a
    // 512-px raster cannot represent: pixel-level agreement is lower than with the previous smooth
    // breakup, while large-scale coasts are identical (block-level test in
    // polish.painter-satellite.test.ts). Was 0.985.
    expect(agree / lo.length).toBeGreaterThan(0.97);
    // Also at extreme display sea levels (the preview deep-sea skip follows the sea level).
    for (const seaLevel of [-3500, 700]) {
      const pv = paintHeightMap(src, opts({ quality: 'preview', seaLevel }), cache);
      const fu = paintHeightMap(src, opts({ quality: 'full', seaLevel }), cache);
      let mismatch = 0, land = 0;
      for (let p = 0; p < pv.length; p++) {
        if (pv[p] > seaLevel !== fu[p] > seaLevel) mismatch++;
        if (fu[p] > seaLevel) land++;
      }
      expect(land).toBeGreaterThan(100);
      expect(land).toBeLessThan(pv.length - 100);
      expect(mismatch).toBe(0);
    }
  });

  it('has no seam at the antimeridian', () => {
    const o = opts();
    const hm = paintHeightMap(src, o, new PaintCache());
    const sat = paintLayer('satellite', src, o, new PaintCache()).rgba;
    const W = o.width;
    // Per column pair (c, c+1 mod W): summed absolute difference down the image.
    const hDiff = new Float64Array(W), cDiff = new Float64Array(W);
    for (let c = 0; c < W; c++) {
      const c1 = (c + 1) % W;
      for (let r = 0; r < o.height; r++) {
        hDiff[c] += Math.abs(hm[r * W + c1] - hm[r * W + c]);
        for (let q = 0; q < 3; q++) cDiff[c] += Math.abs(sat[4 * (r * W + c1) + q] - sat[4 * (r * W + c) + q]);
      }
    }
    // A seam would make the wrap pair an outlier relative to the pairs right next to it.
    const local = (d: Float64Array) => (d[W - 3] + d[W - 2] + d[0] + d[1]) / 4;
    expect(hDiff[W - 1]).toBeLessThan(1.6 * local(hDiff) + 1);
    expect(cDiff[W - 1]).toBeLessThan(1.6 * local(cDiff) + 10);
  });
});

describe('satellite climate response', () => {
  const cache = new PaintCache();
  function whiteFraction(rgba: Uint8ClampedArray, hm: Float32Array, rows: [number, number], W: number): number {
    let white = 0, land = 0;
    for (let r = rows[0]; r < rows[1]; r++) {
      for (let c = 0; c < W; c++) {
        const p = r * W + c;
        if (hm[p] <= 0) continue;
        land++;
        if (rgba[4 * p] > 200 && rgba[4 * p + 1] > 200 && rgba[4 * p + 2] > 200) white++;
      }
    }
    return land > 0 ? white / land : 0;
  }

  it('northern lands are snowier in January than in July', () => {
    const W = 512, rows: [number, number] = [20, 70]; // ≈ 50°N–75°N
    const hm = paintHeightMap(src, opts(), cache);
    const jan = paintLayer('satellite', src, opts({ month: 0 }), cache).rgba;
    const jul = paintLayer('satellite', src, opts({ month: 6 }), cache).rgba;
    expect(whiteFraction(jan, hm, rows, W)).toBeGreaterThan(whiteFraction(jul, hm, rows, W) + 0.2);
  });

  it('a tropical ice-capped massif is white (lapse-corrected alpine belts) and re-classified in the Köppen layer', () => {
    const n = mesh.n;
    const elev = new Float32Array(n).fill(-4000);
    const crust = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const lat = mesh.lat[i], lon = mesh.lon[i];
      const d = Math.hypot(lat, lon);
      if (d < 0.35) {
        crust[i] = CRUST_CONTINENTAL;
        elev[i] = d < 0.12 ? 6500 : 400;
      }
    }
    const s2: WorldSnapshot = { ...snap, id: 777, elev, crust, orogeny: new Float32Array(n).fill(2500) };
    const c2 = climateFor(mesh, s2);
    const o = opts({ month: 6 });
    const sources = { mesh, snapshot: s2, climate: c2 };
    const hm = paintHeightMap(sources, o, cache);
    const sat = paintLayer('satellite', sources, o, cache).rgba;
    const kop = paintLayer('koppen', sources, opts({ hillshade: false }), cache).rgba;
    const ef = KOPPEN_CLASSES[koppenIdFromCode('EF')].color, et = KOPPEN_CLASSES[koppenIdFromCode('ET')].color;
    let high = 0, white = 0, polar = 0;
    for (let p = 0; p < hm.length; p++) {
      if (hm[p] < 5500) continue;
      high++;
      if (sat[4 * p] > 190 && sat[4 * p + 1] > 190 && sat[4 * p + 2] > 190) white++;
      const k = [kop[4 * p], kop[4 * p + 1], kop[4 * p + 2]];
      if ((k[0] === ef[0] && k[1] === ef[1] && k[2] === ef[2]) || (k[0] === et[0] && k[1] === et[1] && k[2] === et[2])) polar++;
    }
    expect(high).toBeGreaterThan(20);
    expect(white / high).toBeGreaterThan(0.7);
    expect(polar / high).toBeGreaterThan(0.9);
  });

  it('deserts are sandy and wet tropics are dark green', () => {
    const o = opts({ quality: 'preview', month: 6, hillshade: false });
    const hm = paintHeightMap(src, o, cache);
    const rgba = paintLayer('satellite', src, o, cache).rgba;
    const kAll = climate.koppenAll;
    const bwh = koppenIdFromCode('BWh'), af = koppenIdFromCode('Af');
    let sandy = 0, nd = 0, green = 0, nf = 0;
    for (let r = 0; r < o.height; r++) {
      const cr = Math.floor((r * climate.h) / o.height);
      for (let c = 0; c < o.width; c++) {
        const p = r * o.width + c;
        if (hm[p] < 50 || hm[p] > 1500) continue;
        const k = kAll[cr * climate.w + Math.floor((c * climate.w) / o.width)];
        const R = rgba[4 * p], G = rgba[4 * p + 1], B = rgba[4 * p + 2];
        if (k === bwh) { nd++; if (R > B + 30 && R + G + B > 330) sandy++; }
        if (k === af) { nf++; if (G > R && G > B && R + G + B < 300) green++; }
      }
    }
    if (nd > 50) expect(sandy / nd).toBeGreaterThan(0.6);
    if (nf > 50) expect(green / nf).toBeGreaterThan(0.6);
    expect(nd + nf).toBeGreaterThan(50);
  });
});

describe('PaintCache', () => {
  it('is keyed by value (clones with the same ids hit) and bounded in bytes', () => {
    const cache = new PaintCache();
    const o = opts({ width: 256, height: 128 });
    paintLayer('satellite', src, o, cache);
    const entries = cache.size, bytes = cache.usedBytes;
    const clone = { mesh, snapshot: structuredClone(snap), climate: structuredClone(climate) };
    paintLayer('satellite', clone, o, cache);
    expect(cache.size).toBe(entries);
    expect(cache.usedBytes).toBe(bytes);
    paintLayer('satellite', { ...clone, snapshot: { ...clone.snapshot, id: 9999 } }, o, cache);
    expect(cache.size).toBeGreaterThan(entries);

    const small = new PaintCache(3_000_000);
    for (let i = 0; i < 4; i++) {
      paintLayer('satellite', { mesh, snapshot: { ...snap, id: 5000 + i }, climate }, o, small);
      expect(small.usedBytes).toBeLessThanOrEqual(3_000_000);
    }
    small.clear();
    expect(small.usedBytes).toBe(0);
  });

  it('does not accumulate per-snapshot entries during playback', () => {
    const cache = new PaintCache();
    const o = opts({ width: 256, height: 128, quality: 'preview' });
    paintLayer('satellite', src, o, cache);
    let peak = 0;
    for (let i = 0; i < 12; i++) {
      paintLayer('satellite', { mesh, snapshot: { ...snap, id: 7000 + i }, climate }, o, cache);
      peak = Math.max(peak, cache.size);
    }
    const settled = cache.size;
    for (let i = 12; i < 20; i++) paintLayer('satellite', { mesh, snapshot: { ...snap, id: 7000 + i }, climate }, o, cache);
    expect(cache.size).toBe(settled);
    expect(peak).toBeLessThanOrEqual(settled);
  });

  it('evicts per-snapshot entries before static ones under byte pressure', () => {
    const o = opts({ width: 256, height: 128, quality: 'preview' });
    const probe = new PaintCache();
    paintLayer('satellite', src, o, probe);
    // Budget: everything from one paint plus ~one more height field.
    const cache = new PaintCache(probe.usedBytes + 600_000);
    paintLayer('satellite', src, o, cache);
    const map = cache.getGridMap(mesh, 256, 128);
    for (let i = 0; i < 6; i++) paintLayer('satellite', { mesh, snapshot: { ...snap, id: 8000 + i }, climate }, o, cache);
    expect(cache.getGridMap(mesh, 256, 128)).toBe(map);
    expect(cache.usedBytes).toBeLessThanOrEqual(cache.maxBytes);
  });

  it('keeps the current height field while playing seasons under byte pressure (LRU, not volatile-first)', () => {
    const o = (month: number) => opts({ width: 256, height: 128, quality: 'full', month });
    const probe = new PaintCache();
    paintLayer('satellite', src, o(0), probe);
    // Room for the first paint plus ~1 more month of climate attributes.
    const cache = new PaintCache(probe.usedBytes + 1_500_000);
    paintLayer('satellite', src, o(0), cache);
    const hKey = heightFieldKey(mesh, snap, o(0));
    const map = cache.getGridMap(mesh, 256, 128);
    for (let m = 1; m < 12; m++) {
      paintLayer('satellite', src, o(m), cache);
      expect(cache.has(hKey)).toBe(true);
      expect(cache.usedBytes).toBeLessThanOrEqual(cache.maxBytes);
    }
    expect(cache.getGridMap(mesh, 256, 128)).toBe(map);
  });

  it('adopts a grid map built elsewhere', () => {
    const cache = new PaintCache();
    const map = buildMeshGridMap(mesh, 128, 64);
    cache.adoptGridMap(mesh, map);
    expect(cache.getGridMap(mesh, 128, 64)).toBe(map);
    expect(() => cache.adoptGridMap(mesh, { ...map, nearest: new Int32Array(3) })).toThrow();
  });
});

describe('paintOverlay', () => {
  const cache = new PaintCache();
  it('draws coastlines on the height-map coast, boundaries near plate boundaries, graticule, transparent elsewhere', () => {
    const o = opts();
    const W = o.width;
    const hm = paintHeightMap(src, o, cache);
    const coast = paintOverlay({ boundaries: false, graticule: false, coastlines: true }, src, o, cache);
    let onCoast = 0, drawn = 0;
    for (let r = 1; r < o.height - 1; r++) {
      for (let c = 0; c < W; c++) {
        const p = r * W + c;
        if (coast[4 * p + 3] < 128) continue;
        drawn++;
        const land = hm[p] > 0;
        const nb = [p - 1, p + 1, p - W, p + W].map((q) => hm[(q + hm.length) % hm.length] > 0);
        if (nb.some((x) => x !== land)) onCoast++;
      }
    }
    expect(drawn).toBeGreaterThan(100);
    expect(onCoast / drawn).toBeGreaterThan(0.9);

    const none = paintOverlay({ boundaries: false, graticule: false, coastlines: false }, src, o, cache);
    expect(none.every((v) => v === 0)).toBe(true);

    const grat = paintOverlay({ boundaries: false, graticule: true, coastlines: false }, src, o, cache);
    // Equator row pair and the 0° meridian carry alpha; a mid-cell pixel does not.
    expect(grat[4 * ((o.height / 2) * W + 10) + 3]).toBeGreaterThan(40);
    expect(grat[4 * (40 * W + W / 2) + 3]).toBeGreaterThan(40);
    expect(grat[4 * (40 * W + W / 2 + 20) + 3]).toBe(0);

    const bnd = paintOverlay({ boundaries: true, graticule: false, coastlines: false }, src, o, cache);
    const map = cache.getGridMap(mesh, W, o.height);
    let near = 0, total = 0;
    for (let p = 0; p < hm.length; p++) {
      if (bnd[4 * p + 3] < 128) continue;
      total++;
      const pl = new Set([snap.plate[map.tri[3 * p]], snap.plate[map.tri[3 * p + 1]], snap.plate[map.tri[3 * p + 2]]]);
      const nbs = [map.nearest[p], ...Array.from({ length: mesh.adjOffset[map.nearest[p] + 1] - mesh.adjOffset[map.nearest[p]] }, (_, j) => mesh.adj[mesh.adjOffset[map.nearest[p]] + j])];
      if (pl.size > 1 || nbs.some((v) => snap.plate[v] !== snap.plate[map.nearest[p]])) near++;
    }
    expect(total).toBeGreaterThan(100);
    expect(near / total).toBeGreaterThan(0.95);
  });
});

describe('data layers', () => {
  const cache = new PaintCache();
  it('currents are tinted warm where SST exceeds the zonal mean and cold where below', () => {
    const c = structuredClone(climate);
    const N = c.w * c.h;
    for (let m = 0; m < 12; m++) {
      for (let r = 0; r < c.h; r++) {
        for (let q = 0; q < c.w; q++) {
          const i = m * N + r * c.w + q;
          c.currentU[i] = 0.5;
          c.currentV[i] = 0;
          c.sst[i] = 15 + (q < c.w / 2 ? 4 : -4);
        }
      }
    }
    const o = opts({ hillshade: false });
    const hm = paintHeightMap(src, o, cache);
    const rgba = paintLayer('currents', { mesh, snapshot: snap, climate: c }, o, cache).rgba;
    let warm = 0, cold = 0, nW = 0, nC = 0;
    for (let r = 60; r < 196; r++) {
      for (let q = 0; q < o.width; q++) {
        const p = r * o.width + q;
        if (hm[p] > 0 || q % (o.width / 2) < 20 || q % (o.width / 2) > o.width / 2 - 20) continue;
        const R = rgba[4 * p], B = rgba[4 * p + 2];
        if (q < o.width / 2) { nW++; if (R > B) warm++; } else { nC++; if (B > R + 40) cold++; }
      }
    }
    expect(warm / nW).toBeGreaterThan(0.8);
    expect(cold / nC).toBeGreaterThan(0.8);
  });

  it('temperature layer cools mountains by the lapse rate', () => {
    const o = opts({ hillshade: false, month: 6 });
    const hm = paintHeightMap(src, o, cache);
    const flat = paintLayer('temperature', { mesh, snapshot: snap, climate }, o, cache).rgba;
    // Same climate, snapshot raised by 2 km everywhere on land ⇒ colder colours on land.
    const raised: WorldSnapshot = { ...snap, id: 4242, elev: snap.elev.map((e) => (e > 0 ? e + 2000 : e)) };
    const cold = paintLayer('temperature', { mesh, snapshot: raised, climate }, o, cache).rgba;
    // Invert the colormap (nearest LUT entry) to recover temperatures.
    const valueOf = (rgba: Uint8ClampedArray, p: number): number => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < CM_TEMP.n; i++) {
        const d = (CM_TEMP.lut[3 * i] - rgba[4 * p]) ** 2 + (CM_TEMP.lut[3 * i + 1] - rgba[4 * p + 1]) ** 2 + (CM_TEMP.lut[3 * i + 2] - rgba[4 * p + 2]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return CM_TEMP.min + ((CM_TEMP.max - CM_TEMP.min) * best) / (CM_TEMP.n - 1);
    };
    const drops: number[] = [];
    for (let p = 0; p < hm.length; p += 7) {
      if (hm[p] < 200) continue;
      const a = valueOf(flat, p), b = valueOf(cold, p);
      if (a < -40 || b < -40) continue; // colormap floor
      drops.push(a - b);
    }
    drops.sort((x, y) => x - y);
    const median = drops[drops.length >> 1];
    expect(drops.length).toBeGreaterThan(100);
    expect(median).toBeGreaterThan(10);
    expect(median).toBeLessThan(16);
  });
});

describe('robustness', () => {
  it('keeps the height map finite when the blur kernel is wider than a tiny raster row', () => {
    const m = smallMesh(4000);
    const s = syntheticSnapshot(m, 4);
    for (const [w, h] of [[4, 120], [3, 100], [2, 90], [5, 150]]) {
      const hm = paintHeightMap({ mesh: m, snapshot: s, climate: null }, opts({ width: w, height: h }), new PaintCache());
      expect(hm.every(Number.isFinite)).toBe(true);
    }
  });

  it('handles tiny/odd sizes, no-land and all-land sea levels, coarse climate grids and month edge values', () => {
    const m = smallMesh(4000);
    const s = syntheticSnapshot(m, 4);
    for (const [w, h] of [[20, 10], [333, 167]]) {
      for (const seaLevel of [-12000, 9000]) {
        const c = zonalClimate(7, 4, undefined, { seaLevel });
        for (const month of [-1, 11, 12]) {
          const o = opts({ width: w, height: h, seaLevel, month, detail: 2 });
          const cache = new PaintCache(50e6);
          for (const layer of LAYERS) {
            const r = paintLayer(layer, { mesh: m, snapshot: s, climate: c }, o, cache);
            expect(r.rgba.length).toBe(w * h * 4);
          }
          const ov = paintOverlay({ boundaries: true, graticule: true, coastlines: true }, { mesh: m, snapshot: s, climate: c }, o, cache);
          expect(ov.length).toBe(w * h * 4);
          expect(paintHeightMap({ mesh: m, snapshot: s, climate: c }, o, cache).every(Number.isFinite)).toBe(true);
        }
      }
    }
  });
});
