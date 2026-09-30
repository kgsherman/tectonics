import { describe, expect, it } from 'vitest';
import { buildMeshGridMap, meshToGrid, resampleGrid } from '../src/core/grid';
import type { PaintOptions } from '../src/core/types';
import { PaintCache, paintHeightMap, paintLayer } from '../src/render/paint';
import { getRiverNetwork } from '../src/render/rivers';
import { routeDrainage } from '../src/render/riversRoute';
import type { RouteInput } from '../src/render/riversRoute';
import { getHeightField, heightFieldKey } from '../src/render/terrain';
import { smallMesh, syntheticSnapshot, zonalClimate } from './helpers/fixtures';

function grid(w: number, h: number, f: (x: number, y: number) => number): Float32Array {
  const e = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) e[r * w + c] = f(c, r);
  return e;
}

function input(w: number, h: number, elev: Float32Array, over: Partial<RouteInput> = {}): RouteInput {
  return {
    w, h, elev, sea: 0,
    runoff: new Float32Array(w * h).fill(300),
    lakeEvap: new Float32Array(w * h).fill(900),
    arid: new Float32Array(w * h).fill(0.1),
    minLakeCells: 4,
    ...over,
  };
}

/** Cell areas (km²) of the routing grid, as used by routeDrainage. */
function areas(w: number, h: number): Float64Array {
  const a = new Float64Array(w * h);
  const dy = (Math.PI / h) * 6.371e6;
  for (let r = 0; r < h; r++) {
    const cl = Math.max(1e-3, Math.cos(Math.PI / 2 - ((r + 0.5) * Math.PI) / h));
    for (let c = 0; c < w; c++) a[r * w + c] = (((2 * Math.PI) / w) * 6.371e6 * cl * dy) / 1e6;
  }
  return a;
}

describe('routeDrainage', () => {
  const w = 128, h = 64;

  it('conserves water on a lake-free island: every land cell drains to the sea', () => {
    // Cone island with a monotone slope (no depressions).
    const elev = grid(w, h, (x, y) => 2500 - 60 * Math.hypot(x - 64, (y - 32) * 2));
    const d = routeDrainage(input(w, h, elev));
    expect(d.lakes.length).toBe(0);
    const a = areas(w, h);
    let total = 0, outflow = 0;
    for (let i = 0; i < w * h; i++) {
      if (d.ocean[i]) continue;
      total += 300e-6 * a[i];
      // Follow the receiver chain: must reach the ocean without cycling.
      let j = i, steps = 0;
      while (j >= 0 && !d.ocean[j] && steps++ < w * h) j = d.recv[j];
      expect(j >= 0 && d.ocean[j] === 1).toBe(true);
      if (d.ocean[d.recv[i]]) outflow += d.q[i];
    }
    expect(Math.abs(outflow - total) / total).toBeLessThan(1e-4);
  });

  it('routes across the antimeridian (longitude wraps)', () => {
    // Land band sloping toward the west edge; the ocean sits just east of the wrap.
    const elev = grid(w, h, (x, y) => (y > 20 && y < 44 ? (x < 100 ? 50 + 10 * x : -500) : -500));
    const d = routeDrainage(input(w, h, elev));
    const i = 32 * w + 0; // westernmost land column: must drain west → wraps to column w−1
    expect(d.ocean[i]).toBe(0);
    expect(d.recv[i] % w).toBe(w - 1);
  });

  it('makes endorheic lakes with salt flats in arid closed basins and cuts the outflow', () => {
    // Plateau at 1000 m with a 400 m deep bowl, sloping down to the sea in the east.
    const elev = grid(w, h, (x, y) => {
      const bowl = Math.hypot(x - 40, (y - 32) * 1.5);
      const base = x < 100 ? 1000 - 4 * x : -300;
      return bowl < 12 ? base - 400 * (1 - bowl / 12) : base;
    });
    const dry = routeDrainage(input(w, h, elev, {
      runoff: new Float32Array(w * h).fill(15), lakeEvap: new Float32Array(w * h).fill(2000), arid: new Float32Array(w * h).fill(0.9),
    }));
    expect(dry.lakes.length).toBe(1);
    const lake = dry.lakes[0];
    expect(lake.endorheic).toBe(true);
    expect(lake.waterCells).toBeLessThan(lake.cells);
    expect(lake.saltLevel).toBeGreaterThan(-Infinity);

    const wet = routeDrainage(input(w, h, elev, { runoff: new Float32Array(w * h).fill(1500), lakeEvap: new Float32Array(w * h).fill(600) }));
    expect(wet.lakes.length).toBe(1);
    expect(wet.lakes[0].endorheic).toBe(false);
    // Open lake: water keeps flowing to the sea downstream of the basin.
    const below = 32 * w + 70;
    expect(wet.q[below]).toBeGreaterThan(dry.q[below] * 10);
  });

  it('gives tiny arid closed basins a finite salt level', () => {
    const elev = grid(w, h, (x, y) => (x < 100 ? 1000 - 4 * x : -300) - (y === 32 && x >= 39 && x <= 41 ? 300 : 0));
    const d = routeDrainage(input(w, h, elev, {
      runoff: new Float32Array(w * h).fill(1), lakeEvap: new Float32Array(w * h).fill(2000), arid: new Float32Array(w * h).fill(0.95), minLakeCells: 3,
    }));
    expect(d.lakes.length).toBe(1);
    expect(Number.isFinite(d.lakes[0].saltLevel)).toBe(true);
  });

  it('never extends a lake zone past its outlet (drained cells below the lake level stay dry)', () => {
    // Plateau at 1000 m with a flat 600 m bowl (radius 8) whose only exit is a 900 m notch on the
    // east rim; right past the notch a canyon drops steeply to the sea, 2 cells from the bowl.
    const bowl = (x: number, y: number) => Math.hypot(x - 40, (y - 32) * 1.2) < 8;
    const elev = grid(w, h, (x, y) => {
      if (bowl(x, y)) return 600;
      if (y === 32 && x >= 48 && x < 60) return x === 48 ? 900 : 700 - 80 * (x - 49);
      return x < 100 ? 1000 : -300;
    });
    const d = routeDrainage(input(w, h, elev, { runoff: new Float32Array(w * h).fill(1500), lakeEvap: new Float32Array(w * h).fill(600) }));
    expect(d.lakes.length).toBe(1);
    const lake = d.lakes[0];
    expect(lake.endorheic).toBe(false);
    expect(lake.level).toBeGreaterThan(700);
    let zone = 0;
    for (let i = 0; i < w * h; i++) {
      if (d.lakeOf[i] !== 0) continue;
      zone++;
      const x = i % w, y = (i / w) | 0;
      if (!bowl(x, y)) expect(elev[i]).toBeGreaterThanOrEqual(lake.level);
    }
    expect(zone).toBeGreaterThan(150);
  });
});

describe('rivers on the satellite layer', () => {
  const mesh = smallMesh(20000);
  const snap = syntheticSnapshot(mesh, 3);
  const map = buildMeshGridMap(mesh, 720, 360);
  const climate = zonalClimate(180, 90, resampleGrid(meshToGrid(map, snap.elev), 720, 360, 180, 90));
  const src = { mesh, snapshot: snap, climate };
  const opts: PaintOptions = { width: 1024, height: 512, month: 6, seaLevel: 0, hillshade: true, seed: 5, quality: 'full' };

  it('draws rivers/lakes only on land, only at full quality, with mouths on the output coast', () => {
    const cache = new PaintCache();
    const hm = paintHeightMap(src, opts, cache);
    const withR = paintLayer('satellite', src, opts, cache).rgba;
    const without = paintLayer('satellite', src, { ...opts, rivers: false }, cache).rgba;
    let changed = 0, onSea = 0;
    for (let p = 0; p < hm.length; p++) {
      const o = 4 * p;
      if (withR[o] !== without[o] || withR[o + 1] !== without[o + 1] || withR[o + 2] !== without[o + 2]) {
        changed++;
        if (hm[p] <= 0) onSea++;
      }
    }
    expect(changed).toBeGreaterThan(200);
    expect(onSea).toBe(0);
    const preview = paintLayer('satellite', src, { ...opts, quality: 'preview' }, cache).rgba;
    const previewNoR = paintLayer('satellite', src, { ...opts, quality: 'preview', rivers: false }, cache).rgba;
    expect(Buffer.from(preview).equals(Buffer.from(previewNoR))).toBe(true);

    const hf = getHeightField(mesh, snap, opts, cache);
    const net = getRiverNetwork(heightFieldKey(mesh, snap, opts), hf, climate, opts, cache);
    expect(net.lines.length).toBeGreaterThan(5);
    let toSea = 0;
    for (const l of net.lines) {
      const m = l.xy.length / 2;
      const x = ((Math.floor(l.xy[2 * m - 2]) % 1024) + 1024) % 1024, y = Math.min(511, Math.max(0, Math.floor(l.xy[2 * m - 1])));
      if (hm[y * 1024 + x] <= 0) toSea++;
      // Every vertex before the mouth stays on land (no river running over the sea).
      for (let k = 0; k < m - 1; k++) {
        const xx = ((Math.floor(l.xy[2 * k]) % 1024) + 1024) % 1024, yy = Math.min(511, Math.max(0, Math.floor(l.xy[2 * k + 1])));
        expect(hm[yy * 1024 + xx] > -50).toBe(true);
      }
    }
    expect(toSea).toBeGreaterThan(0);
  });
});
