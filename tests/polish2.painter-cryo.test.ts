/**
 * Second polish pass of the satellite painter (painter-cryo): winter, ice and relief that read like
 * orbital imagery, clean coasts, dry desert basins.
 *  - winter forests are a crisp mosaic of dark canopy and bright open snow (no grey "TV static"),
 *    bare larch taiga lighter than evergreen taiga, open tundra smooth and bright;
 *  - ice sheets reach the coast where the neighbourhood is glaciated (flow-fed margins);
 *  - baked relief shading (hillshade: true) makes mountains read and stays subtle on plains, while
 *    the globe's albedo (hillshade: false) carries no baked shading;
 *  - coastlines are anti-aliased with sub-pixel coverage from the height field;
 *  - hyper-arid closed basins become playas with at most a small terminal lake, and dryland
 *    channels lose water on the way;
 *  - erg dune grain runs across the prevailing wind.
 */
import { describe, expect, it } from 'vitest';
import { classifyKoppen } from '../src/climate/koppen';
import { buildMeshGridMap, gridLat, meshToGrid, resampleGrid } from '../src/core/grid';
import type { ClimateResult, PaintOptions, SphereMesh, WorldSnapshot } from '../src/core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../src/core/types';
import { PaintCache, paintHeightMap, paintLayer } from '../src/render/paint';
import { coastCoverage } from '../src/render/satelliteCoast';
import { getHeightField } from '../src/render/terrain';
import { routeDrainage } from '../src/render/riversRoute';
import type { RouteInput } from '../src/render/riversRoute';
import { smallMesh, syntheticSnapshot, zonalClimate } from './helpers/fixtures';

const mesh = smallMesh(20000);

function opts(over: Partial<PaintOptions> = {}): PaintOptions {
  return { width: 512, height: 256, month: 0, seaLevel: 0, hillshade: false, seed: 5, quality: 'full', rivers: false, ...over };
}

/** Snapshot with an elevation function of (lat, lon); `oro` adds orogeny (mountain ruggedness). */
function worldFrom(id: number, elevAt: (lat: number, lon: number) => number, oro?: (lat: number, lon: number) => number): WorldSnapshot {
  const base = syntheticSnapshot(mesh, 3, 4);
  const n = mesh.n;
  const elev = new Float32Array(n), crust = new Uint8Array(n), orogeny = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    elev[i] = elevAt(mesh.lat[i], mesh.lon[i]);
    crust[i] = elev[i] > -1000 ? CRUST_CONTINENTAL : CRUST_OCEANIC;
    orogeny[i] = oro ? oro(mesh.lat[i], mesh.lon[i]) : 0;
  }
  return { ...base, id, elev, crust, orogeny, age: new Float32Array(n).fill(300) };
}

function angle(lat: number, lon: number, lat0: number, lon0: number): number {
  const c = Math.sin(lat) * Math.sin(lat0) + Math.cos(lat) * Math.cos(lat0) * Math.cos(lon - lon0);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/**
 * Zonal-fixture climate with prescribed monthly temperature / precipitation per latitude (°) and a
 * uniform wind; Köppen classes recomputed from them.
 */
function climateWith(
  snap: WorldSnapshot, tAt: (latDeg: number, m: number) => number, pAt: (latDeg: number, m: number) => number,
  wind: [number, number] = [-6, 0], id = 900,
): ClimateResult {
  const w = 180, h = 90;
  const map = buildMeshGridMap(mesh, 4 * w, 4 * h);
  const c = structuredClone(zonalClimate(w, h, resampleGrid(meshToGrid(map, snap.elev), 4 * w, 4 * h, w, h)));
  const N = w * h;
  const tt = new Float32Array(12), pp = new Float32Array(12);
  for (let r = 0; r < h; r++) {
    const lat = (gridLat(h, r) * 180) / Math.PI;
    for (let m = 0; m < 12; m++) {
      tt[m] = tAt(lat, m);
      pp[m] = pAt(lat, m);
    }
    const k = classifyKoppen(tt, pp, lat < 0);
    for (let q = 0; q < w; q++) {
      const i = r * w + q;
      // Sea-level temperatures, lapsed to the cell's own land surface (as the model reports them).
      const lapse = c.land[i] ? 0.0065 * Math.max(0, c.elev[i]) : 0;
      let ta = 0, pa = 0;
      for (let m = 0; m < 12; m++) {
        c.temp[m * N + i] = tt[m] - lapse;
        c.precip[m * N + i] = pp[m];
        c.evap[m * N + i] = Math.min(pp[m] * 0.6, Math.max(0, tt[m]) * 5);
        c.windU[m * N + i] = wind[0];
        c.windV[m * N + i] = wind[1];
        ta += tt[m] - lapse;
        pa += pp[m];
      }
      c.tempAnnual[i] = ta / 12;
      c.precipAnnual[i] = pa;
      c.koppenAll[i] = k;
      c.koppen[i] = c.land[i] ? k : 0;
    }
  }
  return { ...c, id };
}

const lum = (a: Uint8ClampedArray, p: number) => (a[4 * p] + a[4 * p + 1] + a[4 * p + 2]) / 3;

/** Land pixels of rows within [lat0, lat1] (degrees), at least 3 px from any sea pixel. */
function inlandPixels(hm: Float32Array, w: number, h: number, lat0: number, lat1: number): number[] {
  const out: number[] = [];
  for (let r = 3; r < h - 3; r++) {
    const lat = (gridLat(h, r) * 180) / Math.PI;
    if (lat < lat0 || lat > lat1) continue;
    for (let c = 0; c < w; c++) {
      let ok = true;
      for (let dr = -3; dr <= 3 && ok; dr++) for (let dc = -3; dc <= 3 && ok; dc++) if (!(hm[(r + dr) * w + ((c + dc + w) % w)] > 0)) ok = false;
      if (ok) out.push(r * w + c);
    }
  }
  return out;
}

describe('winter forests, tundra and ice sheets', () => {
  // A 600 m continent over most of the globe (low hills), no mountains.
  const land = worldFrom(70001, (la, lo) => (angle(la, lo, 0.2, 0.3) < 1.6 ? 600 : -3500));
  /** Boreal climate at every latitude: warmest month `tw`, coldest `tc` (month 0 = mid-winter). */
  const boreal = (tw: number, tc: number, id: number) => climateWith(
    land, (_lat, m) => tc + (tw - tc) * 0.5 * (1 - Math.cos((2 * Math.PI * m) / 12)), () => 45, [-6, 0], id,
  );

  it('winter taiga is a crisp mosaic of dark canopy and bright open snow, not grey static', () => {
    const c = boreal(17, -28, 901);
    const o = opts({ month: 0 });
    const cache = new PaintCache();
    const src = { mesh, snapshot: land, climate: c };
    const hm = paintHeightMap(src, o, cache);
    const rgba = paintLayer('satellite', src, o, cache).rgba;
    const px = inlandPixels(hm, o.width, o.height, -60, 60);
    expect(px.length).toBeGreaterThan(5000);
    let dark = 0, bright = 0, mid = 0, sum = 0;
    for (const p of px) {
      const L = lum(rgba, p);
      sum += L;
      if (L < 140) dark++;
      else if (L > 195) bright++;
      else mid++;
    }
    const n = px.length;
    console.log(`[polish2] winter taiga: mean L ${(sum / n).toFixed(0)}, dark ${(dark / n).toFixed(2)}, open snow ${(bright / n).toFixed(2)}, mid-grey ${(mid / n).toFixed(2)}`);
    // Mostly forest (dark canopy over snow) with crisp open-snow patches; little in-between grey.
    expect(dark / n).toBeGreaterThan(0.45);
    expect(bright / n).toBeGreaterThan(0.04);
    expect(mid / n).toBeLessThan(0.3);
  });

  it('bare larch taiga (Dfd-like, deciduous) is lighter in winter than evergreen taiga', () => {
    const cache = new PaintCache();
    const o = opts({ month: 0 });
    const mean = (c: ClimateResult) => {
      const src = { mesh, snapshot: land, climate: c };
      const hm = paintHeightMap(src, o, cache);
      const rgba = paintLayer('satellite', src, o, cache).rgba;
      const px = inlandPixels(hm, o.width, o.height, -60, 60);
      let s = 0;
      for (const p of px) s += lum(rgba, p);
      return s / px.length;
    };
    const evergreen = mean(boreal(16, -20, 902)); // Dfc
    const larch = mean(boreal(16, -45, 903)); // Dfd: extremely cold winters, deciduous needleleaf
    console.log(`[polish2] winter mean luminance: evergreen taiga ${evergreen.toFixed(0)}, larch taiga ${larch.toFixed(0)}`);
    expect(larch).toBeGreaterThan(evergreen + 15);
  });

  it('winter tundra is a smooth bright snowfield', () => {
    const c = boreal(6, -30, 904); // ET
    const o = opts({ month: 0 });
    const cache = new PaintCache();
    const src = { mesh, snapshot: land, climate: c };
    const hm = paintHeightMap(src, o, cache);
    const rgba = paintLayer('satellite', src, o, cache).rgba;
    const px = inlandPixels(hm, o.width, o.height, -60, 60);
    let s = 0, d = 0;
    for (const p of px) {
      s += lum(rgba, p);
      d += Math.abs(lum(rgba, p) - lum(rgba, p - 1));
    }
    console.log(`[polish2] winter tundra: mean L ${(s / px.length).toFixed(0)}, mean |ΔL| ${(d / px.length).toFixed(2)}`);
    expect(s / px.length).toBeGreaterThan(205);
    expect(d / px.length).toBeLessThan(6);
  });

  it('ice sheets flow down to the coast where the neighbourhood is glaciated', () => {
    // Polar cap continent: EF interior, summers reaching +1.5 °C (sea level) at its coast.
    const cap = worldFrom(70002, (la, lo) => {
      const d = angle(la, lo, -Math.PI / 2, 0);
      return d < 0.5 ? 200 + 2600 * (1 - d / 0.5) : -3000;
    });
    const c = climateWith(cap, (lat, m) => {
      const coast = -61;
      const tw = lat < coast ? 1.5 - 0.6 * (coast - lat) : 6; // warmest month (sea level)
      return tw - 25 + 25 * 0.5 * (1 - Math.cos((2 * Math.PI * (m - 6)) / 12));
    }, () => 20, [-6, 0], 905);
    const o = opts({ month: 0, hillshade: true });
    const cache = new PaintCache();
    const src = { mesh, snapshot: cap, climate: c };
    const hm = paintHeightMap(src, o, cache);
    const rgba = paintLayer('satellite', src, o, cache).rgba;
    // Land pixels within 2 px of the coast.
    let n = 0, white = 0;
    const { width: w, height: h } = o;
    for (let r = 2; r < h - 2; r++) {
      for (let q = 0; q < w; q++) {
        const p = r * w + q;
        if (!(hm[p] > 0)) continue;
        let coastal = false;
        for (let dr = -2; dr <= 2 && !coastal; dr++) for (let dq = -2; dq <= 2 && !coastal; dq++) if (!(hm[(r + dr) * w + ((q + dq + w) % w)] > 0)) coastal = true;
        if (!coastal) continue;
        n++;
        if (lum(rgba, p) > 175) white++;
      }
    }
    console.log(`[polish2] ice-sheet coast: ${n} coastal land px, ${((100 * white) / n).toFixed(1)} % white`);
    expect(n).toBeGreaterThan(100);
    expect(white / n).toBeGreaterThan(0.8);
  });
});

describe('relief shading and coastline anti-aliasing', () => {
  // A rugged orogenic range across a 400 m plain.
  const range = worldFrom(
    70003,
    (la, lo) => {
      const d = Math.abs(la - 0.15 * Math.sin(2 * lo));
      return angle(la, lo, 0, 0) < 1.4 ? 400 + 3200 * Math.max(0, 1 - d / 0.12) : -3500;
    },
    (la, lo) => (Math.abs(la - 0.15 * Math.sin(2 * lo)) < 0.12 ? 4000 : 0),
  );
  const temperate = climateWith(range, (lat, m) => 14 - 0.3 * Math.abs(lat) + 8 * Math.cos((2 * Math.PI * (m - 6)) / 12), () => 70, [-6, 0], 906);
  const src = { mesh, snapshot: range, climate: temperate };

  it('baked relief shading makes mountains read and stays subtle on plains; the albedo path has none', () => {
    const cache = new PaintCache();
    const oShade = opts({ month: 6, hillshade: true, width: 1024, height: 512 });
    const oFlat = { ...oShade, hillshade: false };
    const hm = paintHeightMap(src, oShade, cache);
    const a = paintLayer('satellite', src, oShade, cache).rgba;
    const b = paintLayer('satellite', src, oFlat, cache).rgba;
    // Shading = log-ratio of the shaded to the unshaded luminance.
    let mtn = 0, nm = 0, plain = 0, np = 0;
    for (let p = 0; p < hm.length; p++) {
      if (!(hm[p] > 0)) continue;
      const s = Math.log((lum(a, p) + 1) / (lum(b, p) + 1));
      if (hm[p] > 2000) { mtn += s * s; nm++; }
      else if (hm[p] < 700) { plain += s * s; np++; }
    }
    const sm = Math.sqrt(mtn / nm), sp = Math.sqrt(plain / np);
    console.log(`[polish2] relief shading rms: mountains ${sm.toFixed(3)}, plains ${sp.toFixed(3)}`);
    expect(nm).toBeGreaterThan(500);
    expect(np).toBeGreaterThan(5000);
    // (sRGB luminance: a linear-light shading factor f shows as ≈ f^0.45.)
    expect(sm).toBeGreaterThan(0.07);
    expect(sm).toBeGreaterThan(5 * sp);
    // Albedo path (hillshade: false) is unshaded: identical for the same inputs, whatever the relief.
    const b2 = paintLayer('satellite', src, oFlat, new PaintCache()).rgba;
    expect(Buffer.from(b2).equals(Buffer.from(b))).toBe(true);
  });

  it('anti-aliases the land/sea transition with sub-pixel coverage (the land mask is unchanged)', () => {
    const cache = new PaintCache();
    const o = opts({ month: 6, width: 1024, height: 512 });
    const hm = paintHeightMap(src, o, cache);
    const rgba = paintLayer('satellite', src, o, cache).rgba;
    const { width: w, height: h } = o;
    // Along the coast each pixel takes an intermediate colour: t = (L − L_own) / (L_other − L_own),
    // with L_own two pixels further into its own class and L_other its other-class neighbour. With
    // sub-pixel coverage t spreads over (0, ½); without anti-aliasing it would sit at ≈ 0.
    const ts: number[] = [];
    for (let r = 2; r < h - 2; r++) {
      for (let c = 2; c < w - 2; c++) {
        const p = r * w + c;
        const land = hm[p] > 0;
        // Land-side pixels (the shelf colour ramps too steeply to serve as a reference).
        if (!land) continue;
        for (const d of [1, -1, w, -w]) {
          const q = p + d, ref = p - d, ref2 = p - 2 * d;
          if (hm[q] > 0 === land || hm[ref] > 0 !== land || hm[ref2] > 0 !== land) continue;
          const own = 0.5 * (lum(rgba, ref) + lum(rgba, ref2)), oth = lum(rgba, q);
          if (Math.abs(own - oth) < 30) continue;
          ts.push((lum(rgba, p) - own) / (oth - own));
          break;
        }
      }
    }
    ts.sort((a, b) => a - b);
    const med = ts[ts.length >> 1];
    // Sub-pixel coverage from the height field's signed coast distance: ≥ ½ on the land side,
    // ≤ ½ on the sea side, and spread (the coastline crosses pixels at all sub-pixel positions).
    const hf = getHeightField(mesh, range, o, cache);
    let landSide = 0, seaSide = 0, wrong = 0, partial = 0;
    for (let r = 1; r < h - 1; r++) {
      for (let c = 0; c < w; c++) {
        const p = r * w + c;
        const land = hm[p] > 0;
        const nb = [r * w + ((c + 1) % w), r * w + ((c + w - 1) % w), p - w, p + w];
        if (!nb.some((q) => hm[q] > 0 !== land)) continue;
        const a = coastCoverage(hf, p);
        if (a !== a) continue;
        if (land) landSide++;
        else seaSide++;
        if (land ? a < 0.5 : a > 0.5) wrong++;
        if (a > 0.1 && a < 0.9) partial++;
      }
    }
    console.log(`[polish2] coastline pixels ${ts.length}: median image blend ${med.toFixed(2)}; coverage: ${landSide} land / ${seaSide} sea side, ${((100 * partial) / (landSide + seaSide)).toFixed(0)} % partial, ${wrong} on the wrong side`);
    expect(ts.length).toBeGreaterThan(500);
    expect(med).toBeGreaterThan(0.1);
    expect(med).toBeLessThan(0.45);
    expect(landSide).toBeGreaterThan(1000);
    expect(seaSide).toBeGreaterThan(1000);
    expect(wrong).toBe(0);
    // (A pixel next to the coastline is partly covered only when the line passes within ½ px of its
    // centre: about half of them.)
    expect(partial / (landSide + seaSide)).toBeGreaterThan(0.3);
  });
});

describe('dry basins and deserts', () => {
  const w = 128, h = 64;
  function grid(f: (x: number, y: number) => number): Float32Array {
    const e = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) e[r * w + c] = f(c, r);
    return e;
  }
  function input(elev: Float32Array, over: Partial<RouteInput> = {}): RouteInput {
    return {
      w, h, elev, sea: 0, runoff: new Float32Array(w * h).fill(300), lakeEvap: new Float32Array(w * h).fill(900),
      arid: new Float32Array(w * h).fill(0.1), minLakeCells: 4, ...over,
    };
  }

  it('a hyper-arid closed basin fed by a wet upland is a playa with at most a small terminal lake', () => {
    // Wet upland in the west drains east into a deep hyper-arid bowl; the land slopes to the sea further east.
    const bowl = (x: number, y: number) => Math.hypot(x - 60, (y - 32) * 1.3);
    const elev = grid((x, y) => {
      const base = x < 110 ? 2500 - 18 * x : -300;
      const b = bowl(x, y);
      return b < 14 ? base - 900 * (1 - b / 14) : base + (x > 72 && x < 80 ? 700 : 0);
    });
    const arid = grid((x) => (x < 35 ? 0 : 1));
    const runoff = grid((x) => (x < 35 ? 1200 : 0));
    const d = routeDrainage(input(elev, { arid, runoff, lakeEvap: new Float32Array(w * h).fill(2200) }));
    expect(d.lakes.length).toBeGreaterThan(0);
    const lake = d.lakes.reduce((a, b) => (b.cells > a.cells ? b : a));
    console.log(`[polish2] arid basin: ${lake.cells} cells, water ${lake.waterCells}, salt ${lake.saltLevel > -Infinity}, inflow ${lake.inflow.toFixed(0)} km³/yr, arid ${lake.arid.toFixed(2)}`);
    expect(lake.arid).toBeGreaterThan(0.9);
    expect(lake.waterCells).toBeLessThanOrEqual(Math.ceil(0.06 * lake.cells));
    expect(lake.saltLevel).toBeGreaterThan(-Infinity);
  });

  it('dryland channels lose water on the way (transmission losses), humid ones do not', () => {
    // An east-flowing trough ~4000 km long on a routing grid of ~80 km cells (as at 1024 px):
    // runoff only in its headwaters (an exotic river when the lowland is a desert).
    const W = 512, H = 256;
    const elev = new Float32Array(W * H), runoff = new Float32Array(W * H);
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        elev[r * W + c] = c < 60 ? 3000 - 40 * c + 60 * Math.abs(r - 128) : -300;
        if (c < 8 && Math.abs(r - 128) < 8) runoff[r * W + c] = 800;
      }
    }
    const base = { w: W, h: H, elev, sea: 0, runoff, lakeEvap: new Float32Array(W * H).fill(900), minLakeCells: 4 };
    // Humid headwaters in both cases; the lowland crossed by the river is humid or hyper-arid.
    const aridLow = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) aridLow[i] = i % W >= 10 ? 0.95 : 0.1;
    const wet = routeDrainage({ ...base, arid: new Float32Array(W * H).fill(0.1) });
    const dry = routeDrainage({ ...base, arid: aridLow });
    const at = (d: typeof wet) => d.q[128 * W + 58];
    // A small stream from a single headwater cell dies out in the desert (a wadi).
    const one = new Float32Array(W * H);
    one[128 * W + 2] = 800;
    const wadi = routeDrainage({ ...base, runoff: one, arid: aridLow });
    const wadiWet = routeDrainage({ ...base, runoff: one, arid: new Float32Array(W * H).fill(0.1) });
    console.log(`[polish2] discharge at the mouth: exotic river humid ${at(wet).toFixed(1)} / hyper-arid ${at(dry).toFixed(1)} km³/yr; small stream ${at(wadiWet).toFixed(2)} / ${at(wadi).toFixed(3)}`);
    expect(at(wet)).toBeGreaterThan(0);
    // A large exotic river loses a modest share over ~3700 km of desert …
    expect(at(dry)).toBeLessThan(0.95 * at(wet));
    expect(at(dry)).toBeGreaterThan(0.5 * at(wet));
    // … a small one dies out.
    expect(at(wadiWet)).toBeGreaterThan(1);
    expect(at(wadi)).toBeLessThan(0.01 * at(wadiWet));
  });

  it('erg dune grain runs across the prevailing wind', () => {
    const plain = worldFrom(70004, (la, lo) => (angle(la, lo, 0.2, 0.3) < 1.6 ? 300 : -3500));
    const hot = (wind: [number, number], id: number) => climateWith(plain, () => 28, () => 2, wind, id);
    const o = opts({ month: 6, width: 1024, height: 512 });
    /** Mean squared luminance derivative east–west vs north–south over bright (erg) desert pixels. */
    const aniso = (c: ClimateResult) => {
      const cache = new PaintCache();
      const src = { mesh, snapshot: plain, climate: c };
      const hm = paintHeightMap(src, o, cache);
      const rgba = paintLayer('satellite', src, o, cache).rgba;
      let dx = 0, dy = 0;
      for (const p of inlandPixels(hm, o.width, o.height, -35, 35)) {
        if (lum(rgba, p) < 170) continue; // sand seas are the pale ground
        dx += (lum(rgba, p + 1) - lum(rgba, p - 1)) ** 2;
        dy += (lum(rgba, p + o.width) - lum(rgba, p - o.width)) ** 2;
      }
      return dx / dy;
    };
    const easterly = aniso(hot([-8, 0], 907)), southerly = aniso(hot([0, 8], 908));
    console.log(`[polish2] dune grain E–W / N–S derivative energy: easterly wind ${easterly.toFixed(2)}, southerly wind ${southerly.toFixed(2)}`);
    // Crests transverse to the wind: brightness changes fastest along the wind.
    expect(easterly).toBeGreaterThan(1.1 * southerly);
  });
});

describe('review: preview / full consistency and cache determinism', () => {
  // Rugged orogenic range (as above) — fine ridges at full ruggedness.
  const range = worldFrom(
    70011,
    (la, lo) => {
      const d = Math.abs(la - 0.15 * Math.sin(2 * lo));
      return angle(la, lo, 0, 0) < 1.4 ? 400 + 3200 * Math.max(0, 1 - d / 0.12) : -3500;
    },
    (la, lo) => (Math.abs(la - 0.15 * Math.sin(2 * lo)) < 0.12 ? 4000 : 0),
  );

  it('fine orogenic ridges keep the mean mountain height the same in preview (1024) and full (2048)', () => {
    // The fine ridge term is centred on the detail texture's own mean |coast|, which grows with the
    // texture resolution; a fixed centre biased preview mountains ~80 m high (snowline shift on pause).
    const cache = new PaintCache();
    const src = { mesh, snapshot: range, climate: null };
    const a = paintHeightMap(src, opts({ width: 1024, height: 512, quality: 'preview' }), cache);
    const b = paintHeightMap(src, opts({ width: 2048, height: 1024, quality: 'full' }), cache);
    let d = 0, k = 0;
    for (let r = 0; r < 512; r++) {
      const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / 512;
      for (let q = 0; q < 1024; q++) {
        const lon = -Math.PI + ((q + 0.5) * 2 * Math.PI) / 1024;
        // Belt core chosen by geometry, not by the detailed height (no selection bias).
        if (!(Math.abs(lat - 0.15 * Math.sin(2 * lon)) < 0.06 && angle(lat, lon, 0, 0) < 1.3)) continue;
        const B = 0.25 * (b[2 * r * 2048 + 2 * q] + b[2 * r * 2048 + 2 * q + 1] + b[(2 * r + 1) * 2048 + 2 * q] + b[(2 * r + 1) * 2048 + 2 * q + 1]);
        d += a[r * 1024 + q] - B;
        k++;
      }
    }
    console.log(`[polish2] range mean height preview − full: ${(d / k).toFixed(1)} m over ${k} px`);
    expect(k).toBeGreaterThan(3000);
    expect(Math.abs(d / k)).toBeLessThan(30);
  });

  it('preview satellite frames do not depend on the paint cache history (seed-keyed, lazily filled attributes)', () => {
    const c = climateWith(range, (lat, m) => 14 - 0.4 * Math.abs(lat) + 10 * Math.cos((2 * Math.PI * (m - 6)) / 12), () => 60, [-6, 0], 911);
    // Two states of the world (land where the other has sea) and two seeds through one cache.
    const lower = { ...range, id: 70012, elev: Float32Array.from(range.elev, (e) => e - 500) };
    const o = opts({ quality: 'preview', width: 1024, height: 512, month: 1 });
    const cache = new PaintCache();
    paintLayer('satellite', { mesh, snapshot: range, climate: c }, { ...o, seed: 9 }, cache);
    paintLayer('satellite', { mesh, snapshot: lower, climate: c }, o, cache);
    const seq = paintLayer('satellite', { mesh, snapshot: range, climate: c }, o, cache).rgba;
    const fresh = paintLayer('satellite', { mesh, snapshot: range, climate: c }, o, new PaintCache()).rgba;
    expect(Buffer.from(seq).equals(Buffer.from(fresh))).toBe(true);
    // Neutral (no climate) frames too: the warp differs per seed.
    paintLayer('satellite', { mesh, snapshot: range, climate: null }, { ...o, seed: 9 }, cache);
    const nSeq = paintLayer('satellite', { mesh, snapshot: range, climate: null }, o, cache).rgba;
    const nFresh = paintLayer('satellite', { mesh, snapshot: range, climate: null }, o, new PaintCache()).rgba;
    expect(Buffer.from(nSeq).equals(Buffer.from(nFresh))).toBe(true);
  });
});
