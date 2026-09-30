/**
 * Rivers & lakes for the satellite layer (full quality only; SPEC §7): route runoff (P − ET) over
 * a half-resolution copy of the display height map (riversRoute.ts), trace channels above a
 * discharge threshold into polylines, Chaikin-smooth them, snap mouths to the output coastline and
 * draw them anti-aliased with width ∝ log(discharge); lakes and salt pans are filled on the
 * full-resolution height map so their shores are as crisp as the coastline.
 */
import * as _constants from '../core/constants';
import * as _grid from '../core/grid';
import type { ClimateResult, PaintOptions } from '../core/types';
import * as _colormaps from './colormaps';
import * as _layersCommon from './layersCommon';
import type { PaintCache } from './paintCache';
import * as _riversRoute from './riversRoute';
import type { Drainage } from './riversRoute';
import type { HeightField } from './terrain';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { LAPSE_RATE } = _constants;
const { resampleGrid } = _grid;
const { SRGB_TO_LINEAR, encodeSrgb } = _colormaps;
const { gridLookup, sampleField } = _layersCommon;
const { routeDrainage } = _riversRoute;

/** Per-pixel surface state from the satellite pass (0..255): snow cover and desert weight. */
export interface SurfaceState {
  snow: Uint8Array;
  desert: Uint8Array;
}

export interface RiverNetwork {
  drainage: Drainage;
  /** Routing → output scale factor. */
  f: number;
  /** Polylines in output pixel coordinates (x unwrapped), with per-vertex width (px). */
  lines: Array<{ xy: Float32Array; width: Float32Array }>;
}

/** Discharge (km³/yr) above which a channel is drawn, for an output width. */
export function riverThreshold(w: number): number {
  return 120 * Math.pow(2048 / w, 1.5);
}

function smooth(a: number, b: number, x: number): number {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Climate-derived routing inputs (annual): runoff, open-water evaporation and aridity per cell. */
function routingClimate(climate: ClimateResult | null, rw: number, rh: number, elev: Float32Array, sea: number, cache: PaintCache) {
  const n = rw * rh;
  const runoff = new Float32Array(n), lakeEvap = new Float32Array(n), arid = new Float32Array(n);
  if (!climate) {
    runoff.fill(250);
    lakeEvap.fill(800);
    arid.fill(0.2);
    return { runoff, lakeEvap, arid };
  }
  const c = climate;
  const lk = gridLookup(rw, rh, c.w, c.h, cache);
  const N = c.w * c.h;
  const evapAnn = new Float32Array(N);
  const petAnn = new Float32Array(N);
  for (let m = 0; m < 12; m++) {
    for (let i = 0; i < N; i++) {
      evapAnn[i] += c.evap[m * N + i];
      const t = c.temp[m * N + i];
      petAnn[i] += t > 0 ? 12 + 4.6 * t : 12;
    }
  }
  const hRef = new Float32Array(N);
  for (let i = 0; i < N; i++) hRef[i] = c.land[i] ? Math.max(0, c.elev[i] - c.params.seaLevel) : 0;
  const P = sampleField(c.precipAnnual, c.w, c.h, -1, lk, rw, rh);
  const E = sampleField(evapAnn, c.w, c.h, -1, lk, rw, rh);
  const T = sampleField(c.tempAnnual, c.w, c.h, -1, lk, rw, rh);
  const H = sampleField(hRef, c.w, c.h, -1, lk, rw, rh);
  const PET = sampleField(petAnn, c.w, c.h, -1, lk, rw, rh);
  for (let i = 0; i < n; i++) {
    // Runoff = P − ET from the climate, capped by the Budyko curve (Fu 1981, ω = 2.6) so drylands,
    // where ET ≈ P, do not feed spurious rivers and lakes.
    const phi = PET[i] / Math.max(1, P[i]);
    const budyko = P[i] * ((1 + Math.pow(phi, 2.6)) ** (1 / 2.6) - phi);
    runoff[i] = Math.max(0, Math.min(P[i] - E[i], budyko));
    // Lapse the annual temperature to the cell, then a simple open-water evaporation proxy.
    const t = T[i] + LAPSE_RATE * (H[i] - Math.max(0, elev[i] - sea));
    const ev = Math.max(150, Math.min(2600, 380 + 62 * t));
    lakeEvap[i] = ev;
    arid[i] = 1 - smooth(0.25, 1.1, P[i] / ev);
  }
  return { runoff, lakeEvap, arid };
}

function buildNetwork(hf: HeightField, climate: ClimateResult | null, opts: PaintOptions, cache: PaintCache): RiverNetwork {
  const { w, h } = hf;
  const f = w >= 1024 ? 2 : 1;
  const rw = Math.floor(w / f), rh = Math.floor(h / f);
  const elev = f === 1 ? hf.height.slice() : resampleGrid(hf.height, w, h, rw, rh);
  const sea = opts.seaLevel;
  const rc = routingClimate(climate, rw, rh, elev, sea, cache);
  const minLakeCells = Math.max(6, Math.round(24 * (rw / 1024) * (rw / 1024)));
  const drainage = routeDrainage({ w: rw, h: rh, elev, sea, ...rc, minLakeCells });
  return { drainage, f, lines: traceRivers(drainage, riverThreshold(w), f, w, h, hf, sea) };
}

/** Is routing cell i under lake water? */
function inLakeWater(d: Drainage, i: number): boolean {
  const l = d.lakeOf[i];
  return l >= 0 && d.elev[i] < d.lakes[l].level;
}

function riverWidth(q: number, qmin: number, w: number): number {
  const maxW = 1.7 * Math.max(0.5, w / 2048);
  return Math.min(maxW, 0.4 + 0.28 * Math.log2(Math.max(1, q / qmin)));
}

function traceRivers(d: Drainage, qmin: number, f: number, w: number, h: number, hf: HeightField, sea: number): RiverNetwork['lines'] {
  const { w: rw, h: rh, recv, q, ocean } = d;
  const n = rw * rh;
  const channel = new Uint8Array(n);
  for (let i = 0; i < n; i++) channel[i] = !ocean[i] && q[i] >= qmin && !inLakeWater(d, i) ? 1 : 0;
  const upstream = new Int32Array(n);
  for (let i = 0; i < n; i++) if (channel[i] && recv[i] >= 0 && channel[recv[i]]) upstream[recv[i]]++;
  const sources: number[] = [];
  for (let i = 0; i < n; i++) if (channel[i] && upstream[i] === 0) sources.push(i);
  // Largest rivers first so tributaries end at junctions on the trunk.
  sources.sort((a, b) => q[b] - q[a] || a - b);
  const visited = new Uint8Array(n);
  const lines: RiverNetwork['lines'] = [];
  const xs: number[] = [], ys: number[] = [], ws: number[] = [];
  for (const s of sources) {
    xs.length = 0; ys.length = 0; ws.length = 0;
    let i = s, prevX = NaN, endsAtSea = false;
    for (let guard = 0; guard < n; guard++) {
      const r = (i / rw) | 0, c = i - r * rw;
      let x = (c + 0.5) * f;
      if (prevX === prevX) {
        // Unwrap longitude so the polyline is continuous across the antimeridian.
        while (x - prevX > w / 2) x -= w;
        while (prevX - x > w / 2) x += w;
      }
      prevX = x;
      xs.push(x);
      ys.push((r + 0.5) * f);
      ws.push(riverWidth(q[i], qmin, w));
      if (!channel[i] || visited[i]) {
        endsAtSea = ocean[i] === 1; // mouth (ocean), lake or junction reached
        break;
      }
      visited[i] = 1;
      const j = recv[i];
      if (j < 0) break;
      i = j;
    }
    if (xs.length < 2) continue;
    // Remove the D8 staircase (Douglas–Peucker, ≈0.6 routing cell) before corner cutting.
    const keep = simplify(xs, ys, 0.6 * f);
    const line = chaikin(keep.map((k) => xs[k]), keep.map((k) => ys[k]), keep.map((k) => ws[k]), 3);
    snapMouth(line, hf, sea, w, h, endsAtSea);
    if (line.width.length >= 2) lines.push(line);
  }
  return lines;
}

/** Douglas–Peucker: indices of the vertices kept for tolerance eps (endpoints always kept). */
function simplify(xs: number[], ys: number[], eps: number): number[] {
  const n = xs.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const b = stack.pop() as number, a = stack.pop() as number;
    const dx = xs[b] - xs[a], dy = ys[b] - ys[a];
    const l = Math.hypot(dx, dy) || 1e-9;
    let far = -1, fd = eps;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((xs[k] - xs[a]) * dy - (ys[k] - ys[a]) * dx) / l;
      if (d > fd) { fd = d; far = k; }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push(a, far, far, b);
    }
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(k);
  return out;
}

/** Chaikin corner cutting (endpoints kept), widths interpolated alongside. */
function chaikin(xs: number[], ys: number[], ws: number[], iterations: number): { xy: Float32Array; width: Float32Array } {
  let X = xs.slice(), Y = ys.slice(), W = ws.slice();
  for (let it = 0; it < iterations; it++) {
    const nx = [X[0]], ny = [Y[0]], nw = [W[0]];
    for (let k = 0; k < X.length - 1; k++) {
      nx.push(0.75 * X[k] + 0.25 * X[k + 1], 0.25 * X[k] + 0.75 * X[k + 1]);
      ny.push(0.75 * Y[k] + 0.25 * Y[k + 1], 0.25 * Y[k] + 0.75 * Y[k + 1]);
      nw.push(0.75 * W[k] + 0.25 * W[k + 1], 0.25 * W[k] + 0.75 * W[k + 1]);
    }
    nx.push(X[X.length - 1]);
    ny.push(Y[Y.length - 1]);
    nw.push(W[W.length - 1]);
    X = nx; Y = ny; W = nw;
  }
  const xy = new Float32Array(2 * X.length);
  for (let k = 0; k < X.length; k++) {
    xy[2 * k] = X[k];
    xy[2 * k + 1] = Y[k];
  }
  return { xy, width: Float32Array.from(W) };
}

function isSea(hf: HeightField, x: number, y: number, sea: number, w: number, h: number): boolean {
  const yy = Math.min(h - 1, Math.max(0, Math.floor(y)));
  const xx = ((Math.floor(x) % w) + w) % w;
  return hf.height[yy * w + xx] <= sea;
}

/**
 * Snap the river mouth to the output-resolution coast: the polyline is cut at its first crossing
 * into an output sea pixel; if it never reaches one (the half-resolution routing put the coast a
 * little further on) its last segment is extended up to 4 px until it does. Rivers ending at a
 * junction or a lake are left as they are.
 */
function snapMouth(line: { xy: Float32Array; width: Float32Array }, hf: HeightField, sea: number, w: number, h: number, endsAtSea: boolean): void {
  // Sources whose routing cell centre lands on an output sea pixel start at the first land vertex.
  let first = 0;
  while (first < line.width.length && isSea(hf, line.xy[2 * first], line.xy[2 * first + 1], sea, w, h)) first++;
  if (first > 0) {
    line.xy = line.xy.slice(2 * first);
    line.width = line.width.slice(first);
  }
  const xy = line.xy;
  const m = xy.length / 2;
  if (m < 2) return;
  for (let k = 0; k < m - 1; k++) {
    const x0 = xy[2 * k], y0 = xy[2 * k + 1], x1 = xy[2 * k + 2], y1 = xy[2 * k + 3];
    const l = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(l / 0.5));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      if (isSea(hf, x, y, sea, w, h)) {
        xy[2 * (k + 1)] = x;
        xy[2 * (k + 1) + 1] = y;
        line.xy = xy.slice(0, 2 * (k + 2));
        line.width = line.width.slice(0, k + 2);
        return;
      }
    }
  }
  if (!endsAtSea || m < 2) return;
  const endX = xy[2 * (m - 1)], endY = xy[2 * (m - 1) + 1];
  const dx = endX - xy[2 * (m - 2)], dy = endY - xy[2 * (m - 2) + 1];
  const l = Math.hypot(dx, dy) || 1;
  for (let t = 0.5; t <= 4; t += 0.5) {
    const x = endX + (dx / l) * t, y = endY + (dy / l) * t;
    if (isSea(hf, x, y, sea, w, h)) {
      xy[2 * (m - 1)] = x;
      xy[2 * (m - 1) + 1] = y;
      return;
    }
  }
}

export function getRiverNetwork(heightKey: string, hf: HeightField, climate: ClimateResult | null, opts: PaintOptions, cache: PaintCache): RiverNetwork {
  const key = `rivers|${heightKey}|${climate ? climate.id : 'none'}|${opts.seaLevel}`;
  return cache.getOrBuild(key, () => buildNetwork(hf, climate, opts, cache), (v) => {
    let b = v.drainage.elev.byteLength * 4 + v.drainage.ocean.byteLength;
    for (const l of v.lines) b += l.xy.byteLength + l.width.byteLength + 64;
    return b;
  });
}

// Water colours (linear light).
const RIVER = [SRGB_TO_LINEAR[34], SRGB_TO_LINEAR[58], SRGB_TO_LINEAR[78]];
const LAKE = [SRGB_TO_LINEAR[22], SRGB_TO_LINEAR[52], SRGB_TO_LINEAR[74]];
const LAKE_ICE = [SRGB_TO_LINEAR[214], SRGB_TO_LINEAR[224], SRGB_TO_LINEAR[234]];
const SALT = [SRGB_TO_LINEAR[222], SRGB_TO_LINEAR[216], SRGB_TO_LINEAR[200]];
/** Shallow saline lakes of closed basins: greener, more turbid than open lakes. */
const LAKE_SALINE = [SRGB_TO_LINEAR[40], SRGB_TO_LINEAR[92], SRGB_TO_LINEAR[96]];
const RIPARIAN = [SRGB_TO_LINEAR[62], SRGB_TO_LINEAR[88], SRGB_TO_LINEAR[44]];

function blendPixel(rgba: Uint8ClampedArray, p: number, c: number[], a: number): void {
  if (a <= 0) return;
  const o = 4 * p;
  for (let q = 0; q < 3; q++) {
    const lin = SRGB_TO_LINEAR[rgba[o + q]];
    rgba[o + q] = encodeSrgb(lin + (c[q] - lin) * a);
  }
}

/** Fill lakes and salt pans on the output raster (shores from the full-resolution height map). */
function drawLakes(rgba: Uint8ClampedArray, hf: HeightField, net: RiverNetwork, sea: number, surf: SurfaceState): void {
  const { w, h, height, patch } = hf;
  const d = net.drainage, f = net.f;
  if (d.lakes.length === 0) return;
  for (let y = 0; y < h; y++) {
    const ry = Math.min(d.h - 1, Math.floor(y / f));
    for (let x = 0; x < w; x++) {
      const li = d.lakeOf[ry * d.w + Math.min(d.w - 1, Math.floor(x / f))];
      if (li < 0) continue;
      const lake = d.lakes[li];
      const p = y * w + x;
      const H = height[p];
      if (H <= sea) continue; // lakes are inland water on land pixels only
      if (H < lake.level) {
        const frozen = surf.snow[p] / 255;
        const c = frozen > 0.5 ? LAKE_ICE : lake.endorheic ? LAKE_SALINE : LAKE;
        blendPixel(rgba, p, c, 0.94);
      } else if (H < lake.saltLevel) {
        // Playa: salt crust brightest at the lowest ground, fading and mottled toward the rim.
        const depth = (lake.saltLevel - H) / Math.max(1, lake.saltLevel - lake.floor);
        const a = (0.35 + 0.5 * (depth > 1 ? 1 : depth)) * (0.8 + 0.25 * patch[p]);
        blendPixel(rgba, p, SALT, a > 0.9 ? 0.9 : a);
      }
    }
  }
}

/** Anti-aliased capsule rasterisation of all river segments into coverage buffers, then blend. */
function drawRivers(rgba: Uint8ClampedArray, hf: HeightField, net: RiverNetwork, sea: number, surf: SurfaceState): void {
  const { w, h, height } = hf;
  const cov = new Float32Array(w * h);
  const halo = new Float32Array(w * h);
  const touched: number[] = [];
  for (const line of net.lines) {
    const xy = line.xy, wd = line.width;
    for (let k = 0; k + 1 < wd.length; k++) {
      const x0 = xy[2 * k], y0 = xy[2 * k + 1], x1 = xy[2 * k + 2], y1 = xy[2 * k + 3];
      const r0 = 0.5 * wd[k], r1 = 0.5 * wd[k + 1];
      const hr = 1.2 + 2.5 * Math.max(r0, r1);
      const minX = Math.floor(Math.min(x0, x1) - hr), maxX = Math.ceil(Math.max(x0, x1) + hr);
      const minY = Math.max(0, Math.floor(Math.min(y0, y1) - hr)), maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + hr));
      const dx = x1 - x0, dy = y1 - y0;
      const l2 = dx * dx + dy * dy || 1e-9;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5, py = y + 0.5;
          let t = ((px - x0) * dx + (py - y0) * dy) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = px - (x0 + t * dx), ey = py - (y0 + t * dy);
          const dist = Math.sqrt(ex * ex + ey * ey);
          const rad = r0 + (r1 - r0) * t;
          // Thin rivers (< 1 px) fade in intensity instead of width (sub-pixel AA).
          const vis = Math.min(1, 2 * rad);
          const c = vis * (1 - smooth(Math.max(0, rad - 0.5), rad + 0.5, dist));
          const hc = 1 - smooth(0.4 * hr, hr, dist);
          if (c <= 0 && hc <= 0) continue;
          const p = y * w + (((x % w) + w) % w);
          if (cov[p] === 0 && halo[p] === 0) touched.push(p);
          if (c > cov[p]) cov[p] = c;
          if (hc > halo[p]) halo[p] = hc;
        }
      }
    }
  }
  for (const p of touched) {
    if (height[p] <= sea) continue;
    const snow = surf.snow[p] / 255;
    // Riparian vegetation strips stand out in drylands (Nile-like oases).
    const arid = surf.desert[p] / 255;
    blendPixel(rgba, p, RIPARIAN, 0.5 * halo[p] * arid * (1 - snow));
    // Frozen, snow-covered rivers vanish under the snow.
    blendPixel(rgba, p, RIVER, 0.65 * cov[p] * (1 - smooth(0.3, 0.8, snow)));
  }
}

export function drawRiversAndLakes(
  rgba: Uint8ClampedArray, hf: HeightField, heightKey: string, climate: ClimateResult | null, opts: PaintOptions,
  cache: PaintCache, surf: SurfaceState,
): void {
  const net = getRiverNetwork(heightKey, hf, climate, opts, cache);
  drawLakes(rgba, hf, net, opts.seaLevel, surf);
  drawRivers(rgba, hf, net, opts.seaLevel, surf);
}
