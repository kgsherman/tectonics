/**
 * Polish-phase guarantees of the satellite painter (painter-satellite):
 *  - coastlines follow the simulated coast: vertical detail never floods low plains or raises islands
 *    on shelves beyond the coastal noise band, and the drawn coast matches the mesh coast closely;
 *  - sea ice is tied strictly to the climate field (none where it is 0, area ≈ concentration, crisp);
 *  - ice sheets are clean white (no rock streaks);
 *  - identical large-scale coasts across resolutions, pixel-scale texture at full quality, and a
 *    preview that matches full quality away from rivers / lakes;
 *  - land texture (vegetation / snow mosaics) travels with the plates instead of staying in the world
 *    frame (no crawling patterns during playback).
 */
import { describe, expect, it } from 'vitest';
import { buildMeshGridMap, gridLat, meshToGrid, resampleGrid } from '../src/core/grid';
import { quatFromAxisAngle } from '../src/core/math3';
import type { ClimateResult, PaintOptions, Quat, SphereMesh, WorldSnapshot } from '../src/core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../src/core/types';
import { PaintCache, paintHeightMap, paintLayer } from '../src/render/paint';
import { smallMesh, syntheticSnapshot, zonalClimate } from './helpers/fixtures';

function opts(over: Partial<PaintOptions> = {}): PaintOptions {
  return { width: 512, height: 256, month: 6, seaLevel: 0, hillshade: false, seed: 5, quality: 'full', ...over };
}

function climateFor(mesh: SphereMesh, snap: WorldSnapshot, w = 180, h = 90): ClimateResult {
  const map = buildMeshGridMap(mesh, 4 * w, 4 * h);
  const e = resampleGrid(meshToGrid(map, snap.elev), 4 * w, 4 * h, w, h);
  return zonalClimate(w, h, e);
}

/** Snapshot with an elevation function of (lat, lon) and no orogeny. */
function worldFrom(mesh: SphereMesh, id: number, elevAt: (lat: number, lon: number) => number): WorldSnapshot {
  const base = syntheticSnapshot(mesh, 3, 4);
  const n = mesh.n;
  const elev = new Float32Array(n), crust = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    elev[i] = elevAt(mesh.lat[i], mesh.lon[i]);
    crust[i] = elev[i] > -1000 ? CRUST_CONTINENTAL : CRUST_OCEANIC;
  }
  return { ...base, id, elev, crust, orogeny: new Float32Array(n), age: new Float32Array(n).fill(200) };
}

/** Angular distance (rad) from (lat, lon) to a centre. */
function angle(lat: number, lon: number, lat0: number, lon0: number): number {
  const c = Math.sin(lat) * Math.sin(lat0) + Math.cos(lat) * Math.cos(lat0) * Math.cos(lon - lon0);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/** Truth land mask: sign of the barycentric (undetailed) mesh elevation at the raster. */
function truthMask(mesh: SphereMesh, snap: WorldSnapshot, w: number, h: number): Uint8Array {
  const g = meshToGrid(buildMeshGridMap(mesh, w, h), snap.elev, new Float32Array(w * h));
  return Uint8Array.from(g, (v) => (v > 0 ? 1 : 0));
}

/** Chamfer distance (px) of every pixel to the nearest pixel of the other class (lon wraps). */
function coastDistance(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h).fill(1e9);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const p = r * w + c, m = mask[p];
      const nb = [r * w + ((c + 1) % w), r * w + ((c + w - 1) % w), r > 0 ? p - w : p, r < h - 1 ? p + w : p];
      if (nb.some((q) => mask[q] !== m)) d[p] = 1;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < w * h; k++) {
      const p = pass === 0 ? k : w * h - 1 - k;
      const r = (p / w) | 0, c = p - r * w;
      for (const [dr, dc, cost] of [[-1, 0, 1], [0, -1, 1], [-1, -1, 1.414], [-1, 1, 1.414], [1, 0, 1], [0, 1, 1], [1, 1, 1.414], [1, -1, 1.414]]) {
        if ((pass === 0) !== (dr < 0 || (dr === 0 && dc < 0))) continue;
        const rr = r + dr;
        if (rr < 0 || rr >= h) continue;
        const q = rr * w + ((c + dc + w) % w);
        if (d[q] + cost < d[p]) d[p] = d[q] + cost;
      }
    }
  }
  return d;
}

function lum(rgba: Uint8ClampedArray, p: number): number {
  return (rgba[4 * p] + rgba[4 * p + 1] + rgba[4 * p + 2]) / 3;
}

const mesh = smallMesh(20000);
/** Mesh spacing in pixels at 512×256. */
const SPACING_PX = mesh.spacing / (Math.PI / 256);

describe('coastlines follow the simulated coast', () => {
  it('low hilly plains never flood and shallow shelves never surface beyond the coastal band', () => {
    // A +25 m continental plain in a −3500 m ocean, and a +300 m island on a −40 m shelf.
    const plain = worldFrom(mesh, 50001, (la, lo) => (angle(la, lo, 0.3, 0.5) < 0.9 ? 25 : -3500));
    const shelf = worldFrom(mesh, 50002, (la, lo) => (angle(la, lo, -0.2, -2) < 0.25 ? 300 : -40));
    const band = 4 * SPACING_PX; // coast noise reach (≤ ~3.5 mesh spacings) plus margin
    for (const snap of [plain, shelf]) {
      const o = opts();
      const hm = paintHeightMap({ mesh, snapshot: snap, climate: null }, o, new PaintCache());
      const truth = truthMask(mesh, snap, o.width, o.height);
      const dist = coastDistance(truth, o.width, o.height);
      let farWrong = 0, land = 0;
      for (let p = 0; p < hm.length; p++) {
        if (truth[p]) land++;
        if ((hm[p] > 0 ? 1 : 0) !== truth[p] && dist[p] > band) farWrong++;
      }
      expect(land).toBeGreaterThan(500);
      expect(farWrong).toBe(0);
    }
  });

  it('matches the simulated coastline closely (flooded / spurious land ≤ a few % of the land area)', () => {
    // Truth = each mesh cell's own area (nearest cell): the land area the simulation represents.
    // (The barycentric zero crossing hugs low land next to deep sea; the painter's coast sits at
    // the cell boundary instead, preserving the simulated land area.)
    const snap = syntheticSnapshot(mesh, 3);
    const o = opts({ width: 1024, height: 512 });
    const hm = paintHeightMap({ mesh, snapshot: snap, climate: null }, o, new PaintCache());
    const map = buildMeshGridMap(mesh, o.width, o.height);
    let land = 0, flood = 0, spur = 0;
    for (let r = 0; r < o.height; r++) {
      const wt = Math.cos(gridLat(o.height, r));
      for (let c = 0; c < o.width; c++) {
        const p = r * o.width + c;
        if (snap.elev[map.nearest[p]] > 0) {
          land += wt;
          if (!(hm[p] > 0)) flood += wt;
        } else if (hm[p] > 0) spur += wt;
      }
    }
    console.log(`[polish] fixture coast vs cell areas: flooded ${((100 * flood) / land).toFixed(2)}%, spurious ${((100 * spur) / land).toFixed(2)}%`);
    expect(flood / land).toBeLessThan(0.07);
    expect(spur / land).toBeLessThan(0.09);
  });

  it('keeps the same large-scale coastlines at every resolution (block land fractions)', () => {
    const snap = syntheticSnapshot(mesh, 3);
    const cache = new PaintCache();
    const lo = paintHeightMap({ mesh, snapshot: snap, climate: null }, opts(), cache);
    const hi = paintHeightMap({ mesh, snapshot: snap, climate: null }, opts({ width: 1024, height: 512 }), cache);
    const B = 8;
    let sum = 0, nb = 0, worst = 0;
    for (let br = 0; br < 256 / B; br++) {
      for (let bc = 0; bc < 512 / B; bc++) {
        let a = 0, b = 0;
        for (let r = 0; r < B; r++) for (let c = 0; c < B; c++) a += lo[(br * B + r) * 512 + bc * B + c] > 0 ? 1 : 0;
        for (let r = 0; r < 2 * B; r++) for (let c = 0; c < 2 * B; c++) b += hi[(2 * br * B + r) * 1024 + 2 * bc * B + c] > 0 ? 1 : 0;
        const d = Math.abs(a / (B * B) - b / (4 * B * B));
        sum += d;
        nb++;
        worst = Math.max(worst, d);
      }
    }
    console.log(`[polish] block land-fraction difference 512 vs 1024: mean ${(sum / nb).toFixed(4)}, max ${worst.toFixed(3)}`);
    expect(sum / nb).toBeLessThan(0.02);
    expect(worst).toBeLessThan(0.35);
  });
});

describe('sea ice and ice sheets', () => {
  it('sea ice is tied strictly to the climate field: none where it is 0, area ≈ concentration, crisp', () => {
    const snap = syntheticSnapshot(mesh, 3);
    const c = structuredClone(climateFor(mesh, snap));
    const N = c.w * c.h;
    for (let m = 0; m < 12; m++) {
      for (let r = 0; r < c.h; r++) {
        const lat = (gridLat(c.h, r) * 180) / Math.PI;
        const ice = lat > 76 ? 1 : lat > 58 ? 0.5 : 0;
        for (let q = 0; q < c.w; q++) c.seaIce[m * N + r * c.w + q] = ice;
      }
    }
    const o = opts({ month: 1 });
    const src = { mesh, snapshot: snap, climate: c };
    const cache = new PaintCache();
    const hm = paintHeightMap(src, o, cache);
    const rgba = paintLayer('satellite', src, o, cache).rgba;
    // Open sea only: small enclosed water bodies (lagoons, flooded hollows — frozen in a cold month,
    // buried inside ice sheets) are land-locked water, not sea ice.
    const W = o.width, H = o.height;
    const open = new Uint8Array(W * H);
    {
      const seen = new Uint8Array(W * H);
      for (let s0 = 0; s0 < W * H; s0++) {
        if (seen[s0] || hm[s0] > 0) continue;
        const comp: number[] = [s0];
        seen[s0] = 1;
        for (let k = 0; k < comp.length; k++) {
          const p = comp[k], r = (p / W) | 0, c = p - r * W;
          for (const q of [r * W + ((c + 1) % W), r * W + ((c + W - 1) % W), r > 0 ? p - W : -1, r < H - 1 ? p + W : -1]) {
            if (q < 0 || seen[q] || hm[q] > 0) continue;
            seen[q] = 1;
            comp.push(q);
          }
        }
        if (comp.length >= 64) for (const p of comp) open[p] = 1;
      }
    }
    const count = (lat0: number, lat1: number) => {
      let n = 0, ice = 0, mid = 0;
      for (let r = 0; r < o.height; r++) {
        const lat = (gridLat(o.height, r) * 180) / Math.PI;
        if (lat < lat0 || lat >= lat1) continue;
        for (let q = 0; q < o.width; q++) {
          const p = r * o.width + q;
          if (hm[p] > 0 || !open[p]) continue;
          // Sea pixels on the coastline are anti-aliased with their (snowy) land neighbours.
          if (hm[r * o.width + ((q + 1) % o.width)] > 0 || hm[r * o.width + ((q + o.width - 1) % o.width)] > 0) continue;
          if ((r > 0 && hm[p - o.width] > 0) || (r < o.height - 1 && hm[p + o.width] > 0)) continue;
          n++;
          const L = lum(rgba, p);
          if (L > 150) ice++;
          else if (L > 80) mid++;
        }
      }
      return { n, ice: ice / Math.max(1, n), mid: mid / Math.max(1, n) };
    };
    const none = count(-90, 50), half = count(63, 71), full = count(81, 90);
    console.log(`[polish] sea ice fractions: none-zone ${none.ice.toFixed(4)}, 0.5-zone ${half.ice.toFixed(3)} (intermediate ${half.mid.toFixed(3)}), 1.0-zone ${full.ice.toFixed(3)}`);
    expect(none.n).toBeGreaterThan(1000);
    expect(none.ice).toBe(0);
    expect(half.n).toBeGreaterThan(200);
    expect(half.ice).toBeGreaterThan(0.3);
    expect(half.ice).toBeLessThan(0.75);
    expect(half.mid).toBeLessThan(0.25);
    expect(full.ice).toBeGreaterThan(0.95);
  });

  it('ice sheets are clean white in every season (no rock streaks)', () => {
    const snap = worldFrom(mesh, 50003, (la, lo) => {
      const d = angle(la, lo, -Math.PI / 2, 0);
      return d < 0.45 ? 2800 - 2000 * (d / 0.45) ** 3 : -3000;
    });
    const c = climateFor(mesh, snap);
    const src = { mesh, snapshot: snap, climate: c };
    const cache = new PaintCache();
    for (const month of [0, 6]) {
      const o = opts({ month, hillshade: true });
      const hm = paintHeightMap(src, o, cache);
      const rgba = paintLayer('satellite', src, o, cache).rgba;
      let n = 0, white = 0;
      for (let r = 0; r < o.height; r++) {
        if ((gridLat(o.height, r) * 180) / Math.PI > -72) continue;
        for (let q = 0; q < o.width; q++) {
          const p = r * o.width + q;
          if (hm[p] <= 0) continue;
          n++;
          if (rgba[4 * p] > 185 && rgba[4 * p + 1] > 185 && rgba[4 * p + 2] > 190) white++;
        }
      }
      expect(n).toBeGreaterThan(300);
      expect(white / n).toBeGreaterThan(0.95);
    }
  });
});

describe('texture and preview', () => {
  const snap = syntheticSnapshot(mesh, 3);
  const climate = climateFor(mesh, snap);
  const src = { mesh, snapshot: snap, climate };

  /** Mean |ΔL| between horizontally adjacent land pixels away from coasts (pixel-scale texture). */
  function crispness(rgba: Uint8ClampedArray, hm: Float32Array, w: number): number {
    let s = 0, n = 0;
    for (let p = w; p < hm.length - w - 1; p++) {
      if (hm[p] <= 60 || hm[p + 1] <= 60 || hm[p - w] <= 60 || hm[p + w] <= 60) continue;
      s += Math.abs(lum(rgba, p) - lum(rgba, p + 1));
      n++;
    }
    return s / n;
  }

  it('land has pixel-scale texture at full quality, and the preview keeps most of it', () => {
    const cache = new PaintCache();
    const o = opts({ width: 1024, height: 512 });
    const hm = paintHeightMap(src, o, cache);
    const full = paintLayer('satellite', src, { ...o, rivers: false }, cache).rgba;
    const prev = paintLayer('satellite', src, { ...o, quality: 'preview' }, cache).rgba;
    const cf = crispness(full, hm, 1024), cp = crispness(prev, hm, 1024);
    console.log(`[polish] crispness (mean |ΔL| between land neighbours): full ${cf.toFixed(2)}, preview ${cp.toFixed(2)}`);
    expect(cf).toBeGreaterThan(2.5);
    expect(cp).toBeGreaterThan(0.85 * cf);
  });

  it('preview matches full quality on land (rivers and lakes aside) at the same size', () => {
    const cache = new PaintCache();
    const o = opts({ width: 1024, height: 512 });
    const hm = paintHeightMap(src, o, cache);
    const full = paintLayer('satellite', src, { ...o, rivers: false }, cache).rgba;
    const prev = paintLayer('satellite', src, { ...o, quality: 'preview' }, cache).rgba;
    let dl = 0, nl = 0;
    for (let p = 0; p < hm.length; p++) {
      if (hm[p] <= 0) continue;
      for (let q = 0; q < 3; q++) dl += Math.abs(full[4 * p + q] - prev[4 * p + q]);
      nl += 3;
    }
    expect(nl).toBeGreaterThan(1000);
    expect(dl / nl).toBeLessThan(1);
  });
});

describe('plate anchoring', () => {
  /** One continental plate covering the globe (flat 600 m), with the given rotation. */
  function onePlate(rotation: Quat, id: number): WorldSnapshot {
    const base = syntheticSnapshot(mesh, 3, 2);
    const n = mesh.n;
    return {
      ...base, id, plate: new Int16Array(n), elev: new Float32Array(n).fill(600), crust: new Uint8Array(n).fill(CRUST_CONTINENTAL),
      age: new Float32Array(n).fill(1000), orogeny: new Float32Array(n), boundary: new Uint8Array(n),
      plates: base.plates.slice(0, 1).map((p) => ({ ...p, rotation })),
    };
  }

  it('land texture (vegetation / snow mosaics) moves with the plate, not with the world frame', () => {
    // A zonal climate is invariant under rotation about the pole: rotating the plate by k columns
    // must carry the fine land texture k columns along (it must not stay put in the world frame,
    // which would make the mosaics crawl over the land during playback).
    const W = 1024, H = 512, k = 37;
    const climate = zonalClimate(180, 90, new Float32Array(180 * 90).fill(600));
    const q = quatFromAxisAngle([0, 0, 1], (2 * Math.PI * k) / W);
    /** Luminance minus its 5×5 mean: the fine texture. */
    const highpass = (a: Uint8ClampedArray): Float32Array => {
      const L = new Float32Array(W * H);
      for (let p = 0; p < W * H; p++) L[p] = lum(a, p);
      const out = new Float32Array(W * H);
      for (let r = 2; r < H - 2; r++) {
        for (let c = 0; c < W; c++) {
          let s = 0;
          for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) s += L[(r + dr) * W + ((c + dc + W) % W)];
          out[r * W + c] = L[r * W + c] - s / 25;
        }
      }
      return out;
    };
    for (const month of [0, 6]) {
      const o = opts({ width: W, height: H, month, seed: 3, quality: 'preview' });
      const a = highpass(paintLayer('satellite', { mesh, snapshot: onePlate([0, 0, 0, 1], 60001), climate }, o, new PaintCache()).rgba);
      const b = highpass(paintLayer('satellite', { mesh, snapshot: onePlate(q, 60002), climate }, o, new PaintCache()).rgba);
      for (const [la0, la1] of [[-65, -15], [15, 65]]) {
        // Residual energy of the rotated paint against the original shifted by k (moved) and
        // unshifted (stayed), relative to its own energy (2 = unrelated patterns).
        let moved = 0, stayed = 0, e = 0;
        for (let r = 2; r < H - 2; r++) {
          const lat = (gridLat(H, r) * 180) / Math.PI;
          if (lat < la0 || lat > la1) continue;
          for (let c = 0; c < W; c++) {
            const y = b[r * W + ((c + k) % W)];
            moved += (y - a[r * W + c]) ** 2;
            stayed += (y - a[r * W + ((c + k) % W)]) ** 2;
            e += y * y;
          }
        }
        console.log(`[polish] month ${month} lat ${la0}..${la1}: texture residual moved ${(moved / e).toFixed(2)}, stayed ${(stayed / e).toFixed(2)}`);
        expect(stayed / e).toBeGreaterThan(1.65);
        expect((stayed - moved) / e).toBeGreaterThan(0.3);
      }
    }
  });
});
