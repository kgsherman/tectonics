/**
 * Present-day Earth as a ClimateInput, for calibrating and validating the climate model.
 *
 * NODE/TEST-ONLY: reads world-atlas/land-50m.json from disk. Never import from browser app code.
 *
 * Pipeline (all on a fine "sample" grid of (w·s)×(h·s) cells, s chosen so samples are ≈ 1/8°):
 *  1. Land mask: Natural Earth land polygons rasterized with an antimeridian-safe even–odd scanline
 *     fill (rings are unwrapped in longitude; rings that encircle a pole, i.e. Antarctica, are closed
 *     through that pole).
 *  2. Distance to the coastline (km) by a metric chamfer transform on the sphere.
 *  3. Land elevation = regional base heights (smooth anchors) ramped down toward coasts, combined by
 *     smooth max with hand-authored ranges (polylines), plateaus (polygons) and ice sheets.
 *     Ocean depth = shelf → slope → abyss by distance from the coast, shallow epicontinental seas,
 *     mid-ocean ridges (√-distance subsidence) and trenches.
 *  4. Land-aware box aggregation to w×h: landFraction = mean(land); elev = mean land elevation if
 *     landFraction ≥ 0.5, else mean sea-floor elevation (ClimateInput contract).
 *
 * Heights are ~1° mean terrain heights (not peak heights): what a 1° climate grid should see.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { EARTH_RADIUS_KM } from '../core/constants';
import { createNoise3, fbm3 } from '../core/noise';
import type { ClimateInput } from '../core/types';

/* ================================================================== */
/* Public API                                                          */
/* ================================================================== */

/**
 * Approximate present-day Earth on a w×h climate grid for validating the climate model:
 * land mask from world-atlas land-50m (land-aware supersampling → landFraction), elevation from a
 * continental base plus hand-authored major ranges, plateaus and ice sheets, and ocean depth
 * (shelves near coasts, abyssal elsewhere).
 * Land cells (landFraction ≥ 0.5) always have elev ≥ 1 m and ocean cells elev ≤ −1 m, so
 * `elev > 0` and `landFraction ≥ 0.5` agree. Deterministic; results are cached per size and a fresh
 * copy is returned on every call.
 */
export function buildEarthClimateInput(w: number, h: number): ClimateInput {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 4 || h < 2) {
    throw new Error(`buildEarthClimateInput: invalid grid size ${w}x${h}`);
  }
  const key = `${w}x${h}`;
  let cached = resultCache.get(key);
  if (!cached) {
    cached = computeEarth(w, h);
    resultCache.set(key, cached);
    if (resultCache.size > 6) resultCache.delete(resultCache.keys().next().value as string);
  }
  return {
    w,
    h,
    elev: cached.elev.slice(),
    landFraction: cached.landFraction.slice(),
    time: 0,
  };
}

export interface ReferenceCity {
  name: string;
  lat: number; // degrees
  lon: number; // degrees
  /** Observed Köppen code (Beck et al. 2018). */
  koppen: string;
  /**
   * Station elevation (m). A 1° cell's mean height can differ by >1 km from a city's (coastal plains
   * beside mountains), so validation should lapse-correct model temperatures to this height.
   */
  elev?: number;
}

/** ~80 reference locations spanning all Köppen groups and continents, with station elevations. */
export const REFERENCE_CITIES: ReferenceCity[] = [
  // --- A: tropical ---
  { name: 'Singapore', lat: 1.35, lon: 103.82, koppen: 'Af', elev: 15 },
  { name: 'Iquitos', lat: -3.75, lon: -73.25, koppen: 'Af', elev: 106 },
  { name: 'Belém', lat: -1.46, lon: -48.49, koppen: 'Af', elev: 10 },
  { name: 'Mbandaka', lat: 0.05, lon: 18.26, koppen: 'Af', elev: 350 },
  { name: 'Miami', lat: 25.76, lon: -80.19, koppen: 'Am', elev: 2 },
  { name: 'Freetown', lat: 8.48, lon: -13.23, koppen: 'Am', elev: 26 },
  { name: 'Libreville', lat: 0.39, lon: 9.45, koppen: 'Am', elev: 13 },
  { name: 'Lagos', lat: 6.52, lon: 3.38, koppen: 'Aw', elev: 41 },
  { name: 'Kinshasa', lat: -4.32, lon: 15.31, koppen: 'Aw', elev: 240 },
  { name: 'Darwin', lat: -12.46, lon: 130.84, koppen: 'Aw', elev: 30 },
  { name: 'Bangkok', lat: 13.75, lon: 100.5, koppen: 'Aw', elev: 2 },
  { name: 'Kolkata', lat: 22.57, lon: 88.36, koppen: 'Aw', elev: 9 },
  { name: 'Dar es Salaam', lat: -6.79, lon: 39.21, koppen: 'Aw', elev: 55 },
  { name: 'Cuiabá', lat: -15.6, lon: -56.1, koppen: 'Aw', elev: 165 },
  { name: 'Port Moresby', lat: -9.44, lon: 147.18, koppen: 'Aw', elev: 40 },
  // --- B: arid ---
  { name: 'Cairo', lat: 30.04, lon: 31.24, koppen: 'BWh', elev: 23 },
  { name: 'Riyadh', lat: 24.71, lon: 46.68, koppen: 'BWh', elev: 612 },
  { name: 'Phoenix', lat: 33.45, lon: -112.07, koppen: 'BWh', elev: 331 },
  { name: 'Alice Springs', lat: -23.7, lon: 133.88, koppen: 'BWh', elev: 545 },
  { name: 'Lima', lat: -12.05, lon: -77.04, koppen: 'BWh', elev: 154 },
  { name: 'Karachi', lat: 24.86, lon: 67.01, koppen: 'BWh', elev: 10 },
  { name: 'Timbuktu', lat: 16.77, lon: -3.01, koppen: 'BWh', elev: 261 },
  { name: 'Kashgar', lat: 39.47, lon: 75.99, koppen: 'BWk', elev: 1289 },
  { name: 'Mendoza', lat: -32.89, lon: -68.83, koppen: 'BWk', elev: 746 },
  { name: 'Niamey', lat: 13.51, lon: 2.11, koppen: 'BSh', elev: 207 },
  { name: 'Windhoek', lat: -22.56, lon: 17.08, koppen: 'BSh', elev: 1655 },
  { name: 'Denver', lat: 39.74, lon: -104.99, koppen: 'BSk', elev: 1609 },
  { name: 'Zaragoza', lat: 41.65, lon: -0.88, koppen: 'BSk', elev: 199 },
  { name: 'Comodoro Rivadavia', lat: -45.86, lon: -67.48, koppen: 'BSk', elev: 46 },
  // --- C: temperate ---
  { name: 'Rome', lat: 41.9, lon: 12.5, koppen: 'Csa', elev: 21 },
  { name: 'Lisbon', lat: 38.72, lon: -9.14, koppen: 'Csa', elev: 50 },
  { name: 'Perth', lat: -31.95, lon: 115.86, koppen: 'Csa', elev: 31 },
  { name: 'San Francisco', lat: 37.77, lon: -122.42, koppen: 'Csb', elev: 16 },
  { name: 'Seattle', lat: 47.61, lon: -122.33, koppen: 'Csb', elev: 50 },
  { name: 'Cape Town', lat: -33.92, lon: 18.42, koppen: 'Csb', elev: 25 },
  { name: 'Sydney', lat: -33.87, lon: 151.21, koppen: 'Cfa', elev: 39 },
  { name: 'Buenos Aires', lat: -34.6, lon: -58.38, koppen: 'Cfa', elev: 25 },
  { name: 'Shanghai', lat: 31.23, lon: 121.47, koppen: 'Cfa', elev: 4 },
  { name: 'Tokyo', lat: 35.68, lon: 139.69, koppen: 'Cfa', elev: 40 },
  { name: 'Atlanta', lat: 33.75, lon: -84.39, koppen: 'Cfa', elev: 320 },
  { name: 'London', lat: 51.51, lon: -0.13, koppen: 'Cfb', elev: 11 },
  { name: 'Paris', lat: 48.86, lon: 2.35, koppen: 'Cfb', elev: 35 },
  { name: 'Melbourne', lat: -37.81, lon: 144.96, koppen: 'Cfb', elev: 31 },
  { name: 'Auckland', lat: -36.85, lon: 174.76, koppen: 'Cfb', elev: 30 },
  { name: 'Curitiba', lat: -25.43, lon: -49.27, koppen: 'Cfb', elev: 935 },
  { name: 'Bogotá', lat: 4.71, lon: -74.07, koppen: 'Cfb', elev: 2640 },
  { name: 'Reykjavík', lat: 64.15, lon: -21.94, koppen: 'Cfc', elev: 20 },
  { name: 'Punta Arenas', lat: -53.16, lon: -70.91, koppen: 'Cfc', elev: 34 },
  { name: 'Hong Kong', lat: 22.32, lon: 114.17, koppen: 'Cwa', elev: 30 },
  { name: 'Hanoi', lat: 21.03, lon: 105.85, koppen: 'Cwa', elev: 10 },
  { name: 'Mexico City', lat: 19.43, lon: -99.13, koppen: 'Cwb', elev: 2240 },
  { name: 'Kunming', lat: 25.04, lon: 102.71, koppen: 'Cwb', elev: 1890 },
  { name: 'Johannesburg', lat: -26.2, lon: 28.05, koppen: 'Cwb', elev: 1753 },
  { name: 'Addis Ababa', lat: 9.03, lon: 38.74, koppen: 'Cwb', elev: 2355 },
  // --- D: continental ---
  { name: 'Chicago', lat: 41.88, lon: -87.63, koppen: 'Dfa', elev: 181 },
  { name: 'Minneapolis', lat: 44.98, lon: -93.27, koppen: 'Dfa', elev: 256 },
  { name: 'Moscow', lat: 55.76, lon: 37.62, koppen: 'Dfb', elev: 156 },
  { name: 'Helsinki', lat: 60.17, lon: 24.94, koppen: 'Dfb', elev: 17 },
  { name: 'Novosibirsk', lat: 55.03, lon: 82.92, koppen: 'Dfb', elev: 150 },
  { name: 'Winnipeg', lat: 49.9, lon: -97.14, koppen: 'Dfb', elev: 239 },
  { name: 'Montreal', lat: 45.5, lon: -73.57, koppen: 'Dfb', elev: 36 },
  { name: 'Edmonton', lat: 53.55, lon: -113.49, koppen: 'Dfb', elev: 668 },
  { name: 'Norilsk', lat: 69.35, lon: 88.2, koppen: 'Dfc', elev: 90 },
  { name: 'Yellowknife', lat: 62.45, lon: -114.37, koppen: 'Dfc', elev: 206 },
  { name: 'Murmansk', lat: 68.97, lon: 33.08, koppen: 'Dfc', elev: 50 },
  { name: 'Churchill', lat: 58.77, lon: -94.17, koppen: 'Dfc', elev: 29 },
  { name: 'Yakutsk', lat: 62.03, lon: 129.73, koppen: 'Dfd', elev: 100 },
  { name: 'Beijing', lat: 39.9, lon: 116.4, koppen: 'Dwa', elev: 44 },
  { name: 'Seoul', lat: 37.57, lon: 126.98, koppen: 'Dwa', elev: 38 },
  { name: 'Harbin', lat: 45.8, lon: 126.53, koppen: 'Dwa', elev: 142 },
  { name: 'Vladivostok', lat: 43.12, lon: 131.89, koppen: 'Dwb', elev: 30 },
  // --- E: polar ---
  { name: 'Utqiaġvik', lat: 71.29, lon: -156.79, koppen: 'ET', elev: 3 },
  { name: 'Iqaluit', lat: 63.75, lon: -68.52, koppen: 'ET', elev: 34 },
  { name: 'Resolute', lat: 74.7, lon: -94.83, koppen: 'ET', elev: 67 },
  { name: 'Dikson', lat: 73.51, lon: 80.55, koppen: 'ET', elev: 42 },
  { name: 'Nuuk', lat: 64.18, lon: -51.72, koppen: 'ET', elev: 20 },
  { name: 'Longyearbyen', lat: 78.22, lon: 15.65, koppen: 'ET', elev: 10 },
  { name: 'Nagqu', lat: 31.48, lon: 92.05, koppen: 'ET', elev: 4507 },
  { name: 'Summit Camp', lat: 72.58, lon: -38.46, koppen: 'EF', elev: 3216 },
  { name: 'Vostok', lat: -78.46, lon: 106.84, koppen: 'EF', elev: 3488 },
  { name: 'South Pole', lat: -89.99, lon: 0, koppen: 'EF', elev: 2835 },
  { name: 'Concordia', lat: -75.1, lon: 123.35, koppen: 'EF', elev: 3233 },
];

/** Observed Köppen group shares of the land area, % (Beck et al. 2018, incl. Antarctica). */
export const EARTH_KOPPEN_GROUP_TARGETS: Readonly<Record<'A' | 'B' | 'C' | 'D' | 'E', number>> = {
  A: 19,
  B: 28,
  C: 14,
  D: 22,
  E: 17,
};

/**
 * Observed annual zonal-mean near-surface air temperature (°C) per 10° latitude band, north to south
 * (index 0 = 90–80°N … 17 = 80–90°S). Approximate ERA-Interim/ERA5 1981–2010 climatology (±1–2 °C),
 * at the actual surface (so bands containing Antarctica / Tibet include their elevation).
 */
export const EARTH_ZONAL_MEAN_TEMP: readonly number[] = [
  -18, -12, -5, 2.5, 9, 16, 22.5, 25.5, 26.5, 26, 24.5, 21, 16, 9.5, 3, -5, -24, -44,
];

/** Observed global-mean annual precipitation, mm/yr (GPCP ≈ 1000–1050). */
export const EARTH_GLOBAL_PRECIP_MM = 1000;

/* ================================================================== */
/* Sample grid geometry                                                */
/* ================================================================== */

const KM_PER_DEG = (Math.PI * EARTH_RADIUS_KM) / 180;
const DEG = Math.PI / 180;
/** Target sample density (samples per degree) for land mask & relief. */
const SAMPLES_PER_DEG = 8;
/** Upper bound on samples per axis factor (keeps tiny grids cheap). */
const MAX_SUPERSAMPLE = 32;

interface SampleGrid {
  W: number;
  H: number;
  /** degrees per sample */
  dLat: number;
  dLon: number;
}

function sampleGridFor(w: number, h: number): { grid: SampleGrid; s: number } {
  const s = Math.max(1, Math.min(MAX_SUPERSAMPLE, Math.ceil((360 * SAMPLES_PER_DEG) / w)));
  const W = w * s;
  const H = h * s;
  return { s, grid: { W, H, dLat: 180 / H, dLon: 360 / W } };
}

const rowLat = (g: SampleGrid, r: number): number => 90 - (r + 0.5) * g.dLat;
const colLon = (g: SampleGrid, c: number): number => -180 + (c + 0.5) * g.dLon;

/* ================================================================== */
/* 1. Land polygons → mask                                             */
/* ================================================================== */

/** Each ring as flat [lon0, lat0, lon1, lat1, ...] in unwrapped longitude (closed implicitly). */
let landRings: Float64Array[] | null = null;

function loadLandRings(): Float64Array[] {
  if (landRings) return landRings;
  const require = createRequire(import.meta.url);
  const path = require.resolve('world-atlas/land-50m.json');
  const topo = JSON.parse(readFileSync(path, 'utf8')) as Topology;
  const fc = feature(topo, topo.objects.land as GeometryCollection);
  const rings: Float64Array[] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) for (const ring of poly) rings.push(unwrapRing(ring));
  }
  if (rings.length === 0) throw new Error('earthInput: no land polygons in world-atlas land-50m');
  landRings = rings;
  return rings;
}

/**
 * Make longitudes continuous along the ring (steps ≤ 180°). A ring whose unwrapped longitude
 * gains ±360° encircles a pole (Antarctica): close it through that pole so it bounds a planar region.
 */
function unwrapRing(ring: number[][]): Float64Array {
  const n = ring.length;
  const out: number[] = [];
  let acc = ring[0][0];
  let prev = ring[0][0];
  let latSum = 0;
  for (let i = 0; i < n; i++) {
    const lon = ring[i][0];
    let d = lon - prev;
    d -= 360 * Math.round(d / 360);
    acc = i === 0 ? lon : acc + d;
    prev = lon;
    out.push(acc, ring[i][1]);
    latSum += ring[i][1];
  }
  const net = out[out.length - 2] - out[0];
  if (Math.abs(net) > 180) {
    const pole = latSum < 0 ? -90 : 90;
    out.push(out[out.length - 2], pole, out[0], pole);
  }
  return Float64Array.from(out);
}

/**
 * Even–odd scanline rasterization on the lon-wrapping sample grid (pixel centers). Each crossing at
 * unwrapped x = xw + 360k toggles the parity of all pixels with center > xw in its row, and toggles the
 * row's starting parity when k is odd (the ring's copy one period to the left covers the row start).
 * This is exact for closed rings of any unwrapped extent (see rasterization notes in the header).
 */
function rasterizeLand(g: SampleGrid, rings: Float64Array[]): Uint8Array {
  const { W, H, dLat, dLon } = g;
  const stride = W + 1;
  const flips = new Uint8Array(H * stride);
  const startParity = new Uint8Array(H);
  for (const ring of rings) {
    const n = ring.length >> 1;
    for (let i = 0; i < n; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      const x0 = ring[2 * i], y0 = ring[2 * i + 1];
      const x1 = ring[2 * j], y1 = ring[2 * j + 1];
      if (y0 === y1) continue;
      const ylo = Math.min(y0, y1), yhi = Math.max(y0, y1);
      // Rows whose center latitude φ satisfies ylo ≤ φ < yhi (half-open: no double counts at vertices).
      let rStart = Math.floor((90 - yhi) / dLat - 0.5) + 1;
      let rEnd = Math.floor((90 - ylo) / dLat - 0.5);
      if (rStart < 0) rStart = 0;
      if (rEnd > H - 1) rEnd = H - 1;
      const slope = (x1 - x0) / (y1 - y0);
      for (let r = rStart; r <= rEnd; r++) {
        const phi = 90 - (r + 0.5) * dLat;
        const x = x0 + (phi - y0) * slope;
        const k = Math.floor((x + 180) / 360);
        const xw = x - 360 * k;
        if (k & 1) startParity[r] ^= 1;
        let col = Math.floor((xw + 180) / dLon - 0.5) + 1;
        if (col < 0) col = 0;
        else if (col > W) col = W;
        flips[r * stride + col] ^= 1;
      }
    }
  }
  const mask = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) {
    let p = startParity[r];
    const fo = r * stride;
    const mo = r * W;
    for (let c = 0; c < W; c++) {
      p ^= flips[fo + c];
      mask[mo + c] = p;
    }
  }
  return mask;
}

/* ================================================================== */
/* 2. Distance to the coastline                                        */
/* ================================================================== */

/**
 * Great-circle-ish distance (km) from every sample to the nearest coast sample (a sample with a
 * 4-neighbour of the other kind). Metric 8-neighbour chamfer with per-row zonal spacing; each vertical
 * sweep also runs full wrap-around horizontal sweeps. Error ≲ 8%, ample for shelf/ramp profiles.
 */
function coastDistance(g: SampleGrid, mask: Uint8Array): Float32Array {
  const { W, H } = g;
  const dist = new Float32Array(W * H).fill(1e9);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const m = mask[i];
      const l = r * W + (c === 0 ? W - 1 : c - 1);
      const rr = r * W + (c === W - 1 ? 0 : c + 1);
      if (mask[l] !== m || mask[rr] !== m || (r > 0 && mask[i - W] !== m) || (r < H - 1 && mask[i + W] !== m)) {
        dist[i] = 0;
      }
    }
  }
  const dy = g.dLat * KM_PER_DEG;
  const dxRow = new Float64Array(H);
  for (let r = 0; r < H; r++) dxRow[r] = Math.max(1e-3, g.dLon * KM_PER_DEG * Math.cos(rowLat(g, r) * DEG));

  const rowPass = (r: number, rn: number): void => {
    // Pull from the neighbouring row rn (already final for this sweep).
    const o = r * W;
    const on = rn * W;
    const dxm = 0.5 * (dxRow[r] + dxRow[rn]);
    const dd = Math.sqrt(dxm * dxm + dy * dy);
    for (let c = 0; c < W; c++) {
      const cl = c === 0 ? W - 1 : c - 1;
      const cr = c === W - 1 ? 0 : c + 1;
      let v = dist[o + c];
      const a = dist[on + c] + dy;
      if (a < v) v = a;
      const b = dist[on + cl] + dd;
      if (b < v) v = b;
      const e = dist[on + cr] + dd;
      if (e < v) v = e;
      dist[o + c] = v;
    }
    // Horizontal sweeps with wrap: two laps each way propagate across the seam.
    const dx = dxRow[r];
    for (let k = 1; k < 2 * W; k++) {
      const c = k % W;
      const p = (k - 1) % W;
      const v = dist[o + p] + dx;
      if (v < dist[o + c]) dist[o + c] = v;
    }
    for (let k = 2 * W - 2; k >= 0; k--) {
      const c = k % W;
      const p = (k + 1) % W;
      const v = dist[o + p] + dx;
      if (v < dist[o + c]) dist[o + c] = v;
    }
  };
  for (let it = 0; it < 2; it++) {
    for (let r = 1; r < H; r++) rowPass(r, r - 1);
    for (let r = H - 2; r >= 0; r--) rowPass(r, r + 1);
  }
  return dist;
}

/* ================================================================== */
/* 3a. Relief data                                                     */
/* ================================================================== */

/** [lat, lon, height (m)?, halfWidth (km)?] — omitted values inherit from the previous vertex. */
type RangePt = readonly [number, number, number?, number?];
type LatLon = readonly [number, number];

interface RangeDef {
  name: string;
  pts: readonly RangePt[];
}
interface PlateauDef {
  name: string;
  /** Height (m, land) or depth (m, shallow seas). */
  h: number;
  /** Width (km) of the smooth edge, centred on the outline. */
  edge: number;
  poly: readonly LatLon[];
}

/**
 * Mountain ranges: ~1°-mean crest heights and half-widths. Longitudes may exceed ±180 (unwrapped
 * across the antimeridian). A single point makes a round massif.
 */
const RANGES: readonly RangeDef[] = [
  // ---------------- Asia ----------------
  { name: 'Himalaya', pts: [[35.2, 74.6, 4800, 100], [34.0, 76.0, 5200, 120], [32.5, 77.5, 5500, 130], [30.8, 79.5, 5800, 140], [29.3, 82.5, 6000, 150], [28.5, 84.5, 6000], [28.0, 86.9, 6200], [27.8, 88.5, 6000], [27.9, 91.0, 5600, 140], [28.2, 94.0, 5400, 130], [29.5, 95.5, 5000, 110]] },
  { name: 'Karakoram', pts: [[36.3, 74.5, 5400, 100], [35.5, 76.5, 5800], [34.5, 78.5, 5500]] },
  { name: 'Hindu Kush', pts: [[35.3, 68.5, 3800, 110], [36.0, 70.5, 4500], [36.5, 72.5, 5000], [36.5, 74.0, 5000]] },
  { name: 'Pamir', pts: [[39.0, 71.0, 4000, 150], [38.5, 73.0, 4800], [37.5, 74.5, 4800]] },
  { name: 'Kunlun', pts: [[36.0, 78.0, 5200, 90], [36.3, 82.0, 5400], [36.2, 86.0, 5200], [35.8, 90.0, 5400], [35.5, 94.0, 5200], [35.3, 98.0, 4800]] },
  { name: 'Tian Shan', pts: [[40.5, 69.5, 2800, 110], [41.5, 73.0, 3800, 130], [42.0, 77.0, 4200, 150], [42.3, 80.0, 4600, 130], [43.0, 83.0, 4200], [43.3, 86.5, 4000], [43.2, 89.0, 3500], [43.0, 92.0, 3000], [42.8, 95.0, 2500]] },
  { name: 'Qilian Shan', pts: [[39.3, 95.0, 4200, 110], [38.5, 99.0, 4400], [37.3, 102.5, 3800]] },
  { name: 'Hengduan', pts: [[31.0, 99.3, 4800, 130], [28.5, 99.3, 4600], [26.0, 99.5, 3600], [24.0, 99.0, 2400]] },
  { name: 'Longmen–Daxue', pts: [[33.5, 103.5, 4000, 70], [31.5, 103.3, 4200], [29.5, 102.3, 4200]] },
  { name: 'Qinling', pts: [[34.3, 104.5, 2600, 70], [33.8, 108.0, 2600], [33.5, 111.0, 1800]] },
  { name: 'Altai', pts: [[50.5, 85.5, 3000, 140], [49.5, 88.0, 3400], [47.8, 90.5, 3200], [46.3, 93.5, 3000], [45.3, 96.5, 2600]] },
  { name: 'Sayan', pts: [[51.5, 89.0, 2400, 120], [52.3, 95.0, 2600], [51.8, 100.5, 2600]] },
  { name: 'Khangai', pts: [[48.5, 96.5, 3000, 130], [47.5, 100.0, 3200], [46.8, 102.5, 2800]] },
  { name: 'Greater Khingan', pts: [[42.5, 117.5, 1400, 120], [46.0, 120.0, 1400], [50.0, 121.8, 1200], [52.5, 123.0, 1100]] },
  { name: 'Baikal ranges', pts: [[51.5, 104.0, 2000, 90], [54.0, 108.0, 2000], [56.3, 111.5, 2000]] },
  { name: 'Stanovoy–Yablonovy', pts: [[51.0, 110.0, 1400, 120], [54.0, 116.0, 1500], [56.3, 121.0, 1800], [56.0, 127.0, 1800], [55.5, 133.0, 1600]] },
  { name: 'Dzhugdzhur', pts: [[56.5, 136.0, 1400, 100], [58.5, 139.5, 1400], [60.0, 143.5, 1300]] },
  { name: 'Verkhoyansk', pts: [[71.0, 127.0, 1300, 120], [68.0, 128.5, 1600], [65.5, 131.0, 1700], [63.5, 134.5, 1800], [62.0, 137.5, 1600]] },
  { name: 'Chersky', pts: [[68.5, 139.5, 1700, 160], [66.0, 145.0, 2000], [64.0, 149.5, 1900], [62.5, 153.0, 1600]] },
  { name: 'Kolyma–Chukotka', pts: [[64.0, 156.0, 1300, 180], [64.5, 162.0, 1200], [66.0, 168.0, 1100], [67.0, 174.0, 1000], [66.0, 180.0, 900], [65.8, 184.0, 800]] },
  { name: 'Koryak', pts: [[62.0, 168.0, 1400, 100], [61.0, 172.0, 1500], [63.5, 178.0, 1200]] },
  { name: 'Kamchatka', pts: [[51.5, 157.2, 1500, 70], [54.0, 158.5, 2200], [56.0, 160.0, 2600], [58.0, 161.5, 1800], [60.0, 164.0, 1200]] },
  { name: 'Sikhote-Alin', pts: [[43.0, 133.8, 1200, 90], [45.5, 136.0, 1400], [48.0, 138.5, 1400], [50.5, 140.0, 1200]] },
  { name: 'Sakhalin', pts: [[46.5, 142.8, 900, 40], [49.0, 142.8, 1100], [52.0, 143.0, 800]] },
  { name: 'Changbai', pts: [[42.0, 128.0, 2000, 90], [40.5, 127.0, 1800], [39.5, 127.5, 1500]] },
  { name: 'Taebaek', pts: [[38.5, 128.3, 1100, 60], [37.0, 128.8, 1100], [35.5, 128.0, 1000]] },
  { name: 'Japan', pts: [[45.2, 142.0, 700, 50], [43.6, 142.8, 1600, 70], [42.8, 143.0, 1500], [41.5, 140.5, 900], [40.0, 140.9, 1300], [38.0, 140.3, 1400], [36.6, 138.8, 2000, 80], [35.8, 137.8, 2500, 80], [35.3, 136.2, 1200, 60], [34.4, 135.8, 1300], [33.8, 133.3, 1400], [32.8, 131.2, 1300]] },
  { name: 'Taiwan', pts: [[25.0, 121.5, 2200, 45], [23.6, 121.0, 3000], [22.3, 120.8, 1800]] },
  { name: 'Luzon', pts: [[18.3, 121.0, 1800, 50], [16.5, 121.0, 2200], [15.0, 121.4, 1200]] },
  { name: 'Mindanao', pts: [[8.5, 124.8, 1600, 70], [7.0, 125.2, 2000]] },
  { name: 'Borneo', pts: [[6.2, 116.6, 2600, 80], [4.5, 115.6, 1800], [2.5, 114.5, 1600], [1.0, 113.0, 1400], [0.5, 111.5, 1000]] },
  { name: 'Barisan (Sumatra)', pts: [[5.2, 96.0, 1800, 50], [3.0, 98.0, 1600], [0.0, 100.5, 1700], [-2.5, 101.8, 1600], [-4.5, 103.5, 1500], [-5.5, 104.8, 1000]] },
  { name: 'Java', pts: [[-6.8, 106.8, 1500, 40], [-7.3, 109.5, 1700], [-7.8, 111.8, 1500], [-8.0, 113.5, 1700], [-8.2, 114.3, 1500]] },
  { name: 'Sulawesi', pts: [[1.0, 124.5, 1000, 50], [-1.5, 120.3, 1800, 70], [-4.0, 120.0, 1400]] },
  { name: 'New Guinea', pts: [[-1.0, 133.5, 1800, 60], [-3.2, 136.0, 3000, 100], [-4.0, 138.5, 3600, 110], [-4.8, 140.5, 3200], [-5.6, 143.0, 3200], [-6.5, 145.5, 3300], [-8.3, 147.3, 2500], [-9.8, 149.3, 1500]] },
  { name: 'Western Ghats', pts: [[21.0, 73.7, 900, 70], [18.0, 73.7, 1000], [15.0, 74.2, 900], [12.5, 75.6, 1200], [11.3, 76.7, 1800], [10.2, 77.1, 1800], [8.7, 77.2, 1300]] },
  { name: 'Eastern Ghats', pts: [[21.5, 84.5, 800, 70], [18.5, 83.0, 1000], [16.0, 80.5, 600], [13.5, 79.0, 700]] },
  { name: 'Vindhya–Satpura', pts: [[22.5, 76.0, 700, 100], [22.5, 80.0, 800], [23.0, 83.5, 700]] },
  { name: 'Arakan–Naga', pts: [[27.0, 95.8, 2400, 90], [25.0, 94.4, 2200], [22.5, 93.5, 1800], [20.0, 94.0, 1400], [17.5, 94.6, 1000]] },
  { name: 'Shillong', pts: [[25.5, 90.5, 1200, 60], [25.6, 92.5, 1200]] },
  { name: 'Tenasserim', pts: [[19.0, 98.3, 1500, 70], [16.0, 98.7, 1200], [13.0, 99.2, 1000], [10.5, 98.8, 900]] },
  { name: 'Annamite', pts: [[21.5, 103.5, 1800, 80], [19.0, 104.8, 1600], [16.5, 107.0, 1500], [14.2, 108.2, 1500], [12.0, 108.2, 1400]] },
  { name: 'Sulaiman–Kirthar', pts: [[32.5, 69.8, 2200, 90], [30.5, 69.0, 2400], [28.5, 67.5, 1800], [26.5, 67.2, 1000]] },
  { name: 'Zagros', pts: [[37.8, 44.8, 2800, 100], [35.5, 46.3, 2600, 120], [33.5, 48.2, 2800, 130], [31.5, 50.3, 2800, 120], [29.8, 52.2, 2600], [28.2, 54.5, 2200], [27.3, 56.8, 1800]] },
  { name: 'Alborz', pts: [[36.8, 48.5, 2600, 60], [36.1, 51.5, 3200], [36.6, 54.5, 2600], [37.3, 57.5, 2200]] },
  { name: 'Kopet Dag', pts: [[38.8, 55.8, 1800, 60], [37.8, 58.3, 2000], [36.8, 60.2, 1800]] },
  { name: 'Makran', pts: [[26.2, 58.5, 1400, 80], [26.5, 62.0, 1400], [26.2, 65.5, 1300]] },
  { name: 'Caucasus', pts: [[44.6, 38.5, 2200, 70], [43.4, 42.5, 3400, 90], [42.6, 44.8, 3400], [41.8, 47.0, 3000], [41.0, 48.7, 2200]] },
  { name: 'Lesser Caucasus', pts: [[41.3, 43.5, 2400, 90], [40.0, 45.5, 2600], [39.3, 46.3, 2600]] },
  { name: 'Pontic', pts: [[41.3, 32.5, 1600, 60], [40.9, 36.0, 1800], [40.7, 39.5, 2600], [41.0, 41.8, 2800]] },
  { name: 'Taurus', pts: [[36.8, 29.8, 2200, 70], [36.8, 32.5, 2200], [37.2, 35.3, 2600], [38.0, 37.5, 2400], [38.5, 40.0, 2200], [38.4, 42.5, 2600]] },
  { name: 'Levant', pts: [[36.0, 36.3, 1200, 50], [34.2, 36.1, 2000], [33.0, 35.6, 1000], [31.2, 35.4, 900], [30.0, 35.6, 1200]] },
  { name: 'Hejaz–Asir', pts: [[29.0, 35.3, 1800, 90], [26.5, 37.0, 1600], [24.0, 39.0, 1600], [21.5, 40.3, 2000], [19.0, 42.0, 2400], [17.0, 43.3, 2400]] },
  { name: 'Yemen highlands', pts: [[16.0, 43.9, 2800, 100], [14.2, 44.2, 2800], [13.5, 45.5, 1600]] },
  { name: 'Hajar', pts: [[26.0, 56.2, 1400, 50], [24.0, 56.9, 1600], [23.0, 58.0, 2000], [22.5, 59.3, 1200]] },
  { name: 'Urals', pts: [[68.5, 66.0, 900, 90], [66.5, 64.0, 1200], [64.0, 59.5, 1200], [61.5, 59.0, 1000], [58.5, 59.3, 700], [55.5, 59.0, 900], [53.0, 58.5, 800], [51.5, 58.0, 500]] },
  { name: 'Byrranga', pts: [[74.5, 97.0, 700, 80], [76.0, 108.0, 700]] },
  { name: 'Putorana', pts: [[68.5, 92.0, 1300, 160], [69.0, 96.0, 1400]] },
  { name: 'Novaya Zemlya', pts: [[70.8, 57.0, 600, 40], [73.0, 55.5, 800, 50], [75.5, 61.0, 800], [76.5, 66.0, 600]] },
  { name: 'Svalbard', pts: [[79.5, 16.0, 900, 60], [78.0, 16.0, 900], [77.0, 16.0, 700]] },
  { name: 'Franz Josef Land', pts: [[80.5, 57.0, 400, 60]] },
  { name: 'Severnaya Zemlya', pts: [[79.5, 97.0, 500, 80]] },
  // ---------------- Europe ----------------
  { name: 'Alps', pts: [[44.1, 7.3, 2000, 80], [45.2, 6.9, 2800, 90], [45.9, 7.4, 3000], [46.4, 8.6, 3000], [46.6, 10.0, 2800, 100], [47.0, 11.5, 2800], [47.2, 13.0, 2400], [47.4, 14.8, 1800, 90], [47.6, 15.9, 1100, 60]] },
  { name: 'Jura', pts: [[46.5, 6.3, 1100, 40], [47.4, 7.5, 900]] },
  { name: 'Pyrenees', pts: [[43.1, -1.9, 1300, 50], [42.7, 0.3, 2300, 60], [42.5, 2.2, 1900, 50]] },
  { name: 'Cantabrian', pts: [[43.0, -7.2, 1200, 50], [43.0, -5.0, 1800], [43.0, -3.0, 1200, 40]] },
  { name: 'Sistema Central', pts: [[40.3, -7.3, 1200, 40], [40.3, -5.5, 1800, 45], [40.8, -3.8, 1600, 40], [41.2, -2.5, 1300]] },
  { name: 'Sistema Ibérico', pts: [[42.0, -3.0, 1500, 60], [41.2, -1.8, 1400], [40.3, -1.0, 1500]] },
  { name: 'Betic', pts: [[36.7, -5.2, 1400, 50], [37.0, -3.3, 2400, 60], [37.7, -2.0, 1600, 50], [38.3, -0.8, 1000]] },
  { name: 'Massif Central', pts: [[45.5, 2.8, 1100, 90], [44.5, 3.8, 1100, 80]] },
  { name: 'Apennines', pts: [[44.3, 8.5, 900, 40], [44.2, 10.5, 1500, 50], [43.2, 12.8, 1400], [42.3, 13.5, 2000, 55], [41.3, 14.5, 1500, 50], [40.3, 16.0, 1500], [39.0, 16.4, 1300, 40], [38.2, 15.9, 1400, 35]] },
  { name: 'Sicily', pts: [[37.8, 14.0, 1000, 40], [37.75, 15.0, 2000]] },
  { name: 'Corsica–Sardinia', pts: [[42.2, 9.0, 1500, 40], [40.0, 9.2, 1000, 50]] },
  { name: 'Dinarides–Pindus', pts: [[46.3, 14.5, 1500, 60], [45.0, 15.8, 1200, 70], [44.0, 17.3, 1500, 80], [43.0, 18.8, 1800], [42.4, 20.0, 2000, 70], [41.3, 20.6, 1900], [40.0, 21.2, 2000], [38.8, 21.9, 1800, 60], [37.6, 22.3, 1600, 50]] },
  { name: 'Carpathians', pts: [[48.6, 18.0, 1000, 60], [49.2, 20.0, 1500, 70], [49.0, 22.5, 1100], [48.1, 24.3, 1400], [47.2, 25.3, 1600], [46.0, 25.9, 1500, 60], [45.5, 25.0, 2000], [45.4, 23.3, 1800], [45.0, 22.2, 1200, 50]] },
  { name: 'Balkan', pts: [[43.4, 22.7, 1400, 40], [42.8, 25.0, 1700, 50], [42.7, 26.8, 900, 40]] },
  { name: 'Rila–Rhodope', pts: [[42.1, 23.4, 2200, 60], [41.7, 24.6, 1600, 70], [41.4, 26.0, 1000, 50]] },
  { name: 'Bohemian massif', pts: [[50.5, 13.0, 800, 50], [49.2, 13.5, 900, 60], [50.7, 15.8, 900, 40]] },
  { name: 'Scandinavian', pts: [[58.8, 6.8, 1000, 90], [60.0, 7.5, 1500, 120], [61.5, 8.3, 1700, 110], [62.8, 9.5, 1500], [64.5, 13.5, 1100, 100], [66.5, 15.5, 1200, 90], [68.0, 17.5, 1300, 80], [69.3, 20.0, 1200, 70], [70.2, 24.0, 600, 60]] },
  { name: 'Scottish Highlands', pts: [[58.3, -4.8, 700, 60], [57.1, -4.5, 900, 70], [56.6, -4.2, 800, 60]] },
  { name: 'Wales–Pennines', pts: [[52.5, -3.7, 500, 50], [54.5, -2.3, 500, 40]] },
  { name: 'Vatnajökull', pts: [[64.4, -16.8, 1500, 40], [64.6, -18.0, 1300]] },
  // ---------------- Africa ----------------
  { name: 'Atlas', pts: [[30.5, -9.3, 1600, 70], [31.2, -7.8, 3000, 90], [31.9, -5.8, 2600, 100], [32.8, -4.0, 2200, 90], [33.8, -1.5, 1500], [34.3, 1.5, 1400], [34.8, 4.5, 1500, 80], [35.2, 6.5, 1800, 70], [35.4, 8.5, 1100, 50]] },
  { name: 'Rif–Tell Atlas', pts: [[35.1, -5.3, 1600, 40], [35.2, -3.6, 1500], [36.3, 1.5, 1200], [36.4, 4.5, 1800], [36.6, 6.8, 1100]] },
  { name: 'Ahaggar', pts: [[23.3, 5.6, 1900, 250]] },
  { name: 'Tassili', pts: [[25.0, 8.5, 1300, 150]] },
  { name: 'Tibesti', pts: [[21.0, 17.5, 2200, 200]] },
  { name: 'Ennedi', pts: [[17.0, 22.5, 1000, 120]] },
  { name: 'Aïr', pts: [[18.5, 8.6, 1400, 140]] },
  { name: 'Darfur', pts: [[13.0, 24.3, 1800, 150]] },
  { name: 'Cameroon line', pts: [[4.2, 9.2, 2000, 50], [6.0, 10.5, 1800, 70], [7.0, 12.5, 1400, 100], [7.5, 14.5, 1200]] },
  { name: 'Jos', pts: [[9.6, 8.9, 1300, 90]] },
  { name: 'Guinea Highlands', pts: [[11.3, -12.3, 1100, 100], [10.0, -11.0, 900], [8.8, -9.5, 900, 90], [7.6, -8.2, 1000, 70]] },
  { name: 'Red Sea Hills', pts: [[28.5, 33.8, 1600, 60], [26.0, 33.8, 1300, 70], [23.5, 35.0, 1300], [21.0, 36.4, 1200, 80], [18.5, 37.3, 1300, 90]] },
  { name: 'Simien', pts: [[13.2, 38.3, 3300, 120], [11.3, 39.4, 3200, 110]] },
  { name: 'Bale–Arsi', pts: [[7.5, 39.3, 3200, 120], [6.7, 39.8, 3000, 100]] },
  { name: 'Kenya highlands', pts: [[1.0, 35.5, 2400, 90], [-0.3, 36.3, 2500], [-1.1, 36.9, 2200, 80]] },
  { name: 'Kilimanjaro', pts: [[-3.1, 37.3, 2600, 60]] },
  { name: 'Albertine Rift', pts: [[1.0, 30.1, 2200, 50], [-1.5, 29.5, 2300, 60], [-3.5, 29.3, 1900], [-6.0, 29.8, 1700, 70], [-8.5, 31.0, 1800]] },
  { name: 'Southern Highlands', pts: [[-7.5, 35.7, 1800, 80], [-9.3, 33.7, 2000, 70], [-11.0, 34.0, 1800, 60], [-14.0, 34.5, 1500], [-16.0, 35.6, 1600]] },
  { name: 'Drakensberg', pts: [[-27.0, 30.0, 2100, 80], [-28.8, 29.2, 2800], [-30.2, 28.5, 2400, 70], [-31.5, 27.0, 1800, 80], [-32.5, 25.0, 1600, 70]] },
  { name: 'Mpumalanga escarpment', pts: [[-23.5, 30.2, 1600, 60], [-25.5, 30.6, 1800]] },
  { name: 'Cape Fold Belt', pts: [[-32.5, 19.2, 1300, 50], [-33.5, 20.5, 1300, 45], [-33.6, 23.0, 1300], [-33.4, 25.0, 1000, 40]] },
  { name: 'Namibian escarpment', pts: [[-18.0, 15.0, 1600, 120], [-20.5, 16.0, 1800], [-22.8, 16.8, 2000, 110], [-25.5, 16.8, 1500], [-27.5, 17.0, 1300]] },
  { name: 'Bié Plateau', pts: [[-9.5, 14.8, 1400, 120], [-11.5, 15.3, 1800, 130], [-13.3, 15.8, 1900], [-15.5, 15.0, 1500, 120]] },
  { name: 'Zimbabwe highveld', pts: [[-17.2, 30.8, 1500, 160], [-19.5, 30.0, 1400]] },
  { name: 'Eastern Highlands', pts: [[-18.3, 32.8, 2000, 50], [-20.0, 32.9, 1800]] },
  { name: 'Madagascar', pts: [[-12.8, 49.3, 1200, 60], [-15.0, 48.8, 1600, 80], [-17.5, 47.5, 1700, 110], [-19.8, 47.2, 1800], [-22.0, 46.8, 1500, 100], [-24.5, 46.3, 1000, 80]] },
  // ---------------- North America ----------------
  { name: 'Rocky Mountains', pts: [[59.5, -126.5, 1800, 130], [56.5, -123.0, 2200, 140], [53.5, -118.8, 2600, 150], [51.0, -116.0, 2800, 160], [49.0, -114.2, 2600, 170], [47.0, -113.3, 2400, 180], [45.2, -111.0, 2800, 190], [43.5, -110.0, 2900, 180], [42.0, -107.5, 2500, 170], [40.3, -106.0, 3200, 220], [38.5, -106.0, 3300, 220], [37.0, -106.0, 3000, 180], [35.5, -105.7, 2500, 120]] },
  { name: 'Uinta–Wasatch', pts: [[41.8, -111.7, 2500, 50], [40.7, -110.5, 3000, 60], [39.5, -111.5, 2700]] },
  { name: 'Bighorn', pts: [[44.4, -107.2, 2400, 60]] },
  { name: 'Idaho batholith', pts: [[47.5, -115.5, 1900, 120], [45.5, -115.0, 2300, 140], [44.3, -114.5, 2400, 120]] },
  { name: 'Blue Mountains', pts: [[45.2, -118.3, 1600, 70]] },
  { name: 'Sierra Nevada', pts: [[40.3, -121.3, 1800, 55], [39.3, -120.3, 2400], [38.0, -119.4, 2900], [36.7, -118.5, 3100], [35.6, -118.2, 2000, 45]] },
  { name: 'Cascades', pts: [[49.0, -121.3, 1800, 60], [47.5, -121.3, 1600], [46.2, -121.6, 1800], [44.6, -121.9, 1600], [43.0, -122.2, 1600, 55], [41.4, -122.2, 1900], [40.6, -121.8, 1600, 50]] },
  { name: 'Coast Mountains', pts: [[59.5, -135.0, 1800, 80], [58.0, -132.5, 1800, 90], [56.0, -129.8, 1900], [54.0, -128.3, 1700], [52.0, -126.2, 2000], [50.5, -124.0, 2000, 80], [49.5, -122.5, 1600, 60]] },
  { name: 'Vancouver Island', pts: [[50.3, -126.0, 1200, 40], [49.2, -124.8, 1300]] },
  { name: 'Olympics', pts: [[47.8, -123.6, 1400, 40]] },
  { name: 'Klamath', pts: [[41.8, -123.3, 1300, 70]] },
  { name: 'California Coast Ranges', pts: [[40.5, -123.7, 900, 40], [38.5, -122.8, 600, 35], [36.8, -121.6, 700, 40], [35.3, -120.5, 700, 35]] },
  { name: 'Transverse–Peninsular–Baja', pts: [[34.4, -118.8, 1300, 45], [34.2, -117.0, 1800, 50], [33.3, -116.6, 1400], [31.5, -115.8, 1600], [29.5, -114.3, 1000], [27.3, -112.8, 900], [25.0, -111.3, 700], [23.5, -110.0, 1000, 40]] },
  { name: 'Alaska Range', pts: [[59.5, -154.5, 1500, 70], [61.5, -153.0, 1800, 80], [63.0, -150.5, 2600], [63.3, -147.0, 2200], [62.8, -143.5, 2000, 70]] },
  { name: 'Chugach–St Elias', pts: [[61.2, -148.5, 2000, 70], [61.5, -144.5, 2600, 90], [60.8, -141.0, 3000, 100], [59.8, -138.5, 2500, 90]] },
  { name: 'Alaska Peninsula', pts: [[58.5, -155.0, 1000, 40], [56.5, -158.5, 900], [55.3, -161.5, 800, 30]] },
  { name: 'Brooks Range', pts: [[68.3, -163.0, 900, 70], [68.0, -157.0, 1300, 90], [68.3, -151.0, 1600], [68.6, -146.0, 1800], [69.0, -142.0, 1500, 80]] },
  { name: 'Mackenzie Mountains', pts: [[65.8, -137.0, 1300, 110], [64.5, -132.0, 1700, 130], [62.5, -128.5, 1800, 120], [60.5, -126.0, 1500, 100]] },
  { name: 'Ogilvie–Richardson', pts: [[66.5, -138.0, 1200, 80], [65.0, -140.0, 1300]] },
  { name: 'Torngat', pts: [[59.5, -64.0, 1100, 70], [57.5, -62.5, 800]] },
  { name: 'Baffin mountains', pts: [[72.8, -79.0, 1100, 90], [71.0, -72.0, 1400, 110], [68.5, -67.0, 1400, 100], [66.5, -64.5, 1200, 80]] },
  { name: 'Ellesmere–Axel Heiberg', pts: [[82.3, -72.0, 1500, 130], [80.8, -78.0, 1600, 140], [79.3, -83.5, 1500, 120], [79.5, -91.0, 1300, 100]] },
  { name: 'Devon ice cap', pts: [[75.3, -82.5, 1200, 90]] },
  { name: 'Appalachians', pts: [[34.0, -85.8, 600, 120], [35.6, -83.4, 1200], [37.0, -81.3, 1000, 150], [38.5, -79.8, 1000], [40.3, -78.0, 700], [41.8, -75.3, 700, 130], [42.3, -74.3, 1000, 90], [44.1, -71.5, 1100, 100], [45.2, -70.0, 800, 120], [47.0, -67.5, 500], [48.8, -65.5, 800, 80]] },
  { name: 'Adirondacks', pts: [[44.1, -74.1, 900, 80]] },
  { name: 'Ozark–Ouachita', pts: [[36.5, -92.5, 500, 150], [34.6, -94.2, 500, 80]] },
  { name: 'Sierra Madre Occidental', pts: [[31.2, -108.8, 1800, 90], [29.0, -108.3, 2300, 110], [27.0, -107.3, 2500], [24.8, -105.7, 2600], [22.5, -104.5, 2400, 100], [21.3, -104.3, 2000, 70]] },
  { name: 'Sierra Madre Oriental', pts: [[29.0, -102.0, 1800, 60], [27.0, -101.3, 2200, 70], [25.3, -100.3, 2600], [23.5, -99.6, 2400], [21.5, -99.0, 2300], [20.3, -98.2, 2600, 60]] },
  { name: 'Trans-Mexican Volcanic Belt', pts: [[20.5, -104.3, 2300, 70], [19.7, -102.0, 2400, 80], [19.4, -100.0, 2700], [19.2, -98.8, 3100, 70], [19.0, -97.3, 2800, 60]] },
  { name: 'Sierra Madre del Sur', pts: [[18.3, -101.5, 2200, 70], [17.5, -99.5, 2400, 80], [16.8, -97.3, 2600, 90], [16.3, -95.5, 1600, 60]] },
  { name: 'Central American cordillera', pts: [[16.5, -92.8, 2000, 70], [15.3, -91.0, 2600], [14.5, -89.3, 1800, 60], [14.0, -87.0, 1600, 70], [13.0, -86.0, 1200], [10.3, -84.3, 1800, 50], [9.3, -83.3, 2400], [8.7, -82.3, 1600, 40]] },
  { name: 'Hispaniola', pts: [[19.0, -71.0, 2000, 50], [18.4, -72.5, 1400, 40]] },
  { name: 'Sierra Maestra', pts: [[20.0, -76.5, 1200, 40]] },
  { name: 'Jamaica', pts: [[18.1, -76.8, 1500, 30]] },
  // ---------------- South America ----------------
  { name: 'Mérida Andes', pts: [[7.5, -72.3, 2500, 60], [8.6, -71.0, 3200], [9.8, -69.8, 2200, 50]] },
  { name: 'Cordillera Oriental (Colombia)', pts: [[1.5, -76.3, 3000, 70], [3.5, -75.0, 3000], [5.0, -73.8, 3000, 90], [6.5, -72.6, 3200, 80], [7.3, -72.4, 2800, 60]] },
  { name: 'Cordillera Central (Colombia)', pts: [[1.0, -77.3, 3200, 80], [3.0, -76.2, 3000, 70], [5.0, -75.6, 3000], [6.5, -75.9, 2500], [7.5, -75.8, 1800, 50]] },
  { name: 'Andes', pts: [[0.5, -77.8, 3400, 90], [-1.5, -78.6, 3600, 100], [-4.0, -79.2, 2400, 90], [-6.5, -78.3, 3000, 100], [-9.0, -77.6, 4000, 120], [-11.5, -76.0, 4200, 140], [-13.5, -73.5, 4300, 160], [-15.5, -71.3, 4600, 150], [-17.5, -69.5, 4800, 120], [-20.0, -68.6, 4600], [-22.5, -67.9, 4700], [-25.0, -68.2, 4600, 130], [-27.5, -68.7, 4800, 120], [-30.0, -69.8, 4300, 100], [-32.5, -70.1, 4200, 90], [-34.5, -70.3, 3600, 80], [-36.5, -70.8, 2600], [-38.5, -71.2, 2000], [-41.0, -71.8, 1700], [-44.0, -72.3, 1500, 90], [-47.0, -73.2, 1800], [-49.5, -73.4, 1800, 80], [-51.5, -73.2, 1400, 70], [-53.5, -71.8, 900, 60], [-54.5, -69.0, 900, 50], [-54.8, -66.5, 500, 30]] },
  { name: 'Cordillera Oriental (Bolivia)', pts: [[-13.0, -71.5, 4200, 80], [-14.5, -70.0, 4600, 90], [-15.8, -68.4, 4800], [-17.5, -66.3, 4200, 110], [-19.5, -65.4, 3800], [-21.8, -65.2, 3600], [-24.0, -65.5, 3200, 100], [-26.5, -65.8, 3000, 90]] },
  { name: 'Sierras Pampeanas', pts: [[-27.0, -66.3, 3500, 70], [-29.0, -67.5, 3000, 80]] },
  { name: 'Sierras de Córdoba', pts: [[-30.5, -64.6, 1600, 50], [-32.5, -64.9, 1500]] },
  { name: 'Santa Marta', pts: [[10.85, -73.7, 3000, 45]] },
  { name: 'Venezuelan Coastal Range', pts: [[10.4, -68.0, 1600, 40], [10.3, -65.5, 1400], [10.4, -63.5, 1200, 30]] },
  { name: 'Guiana Highlands', pts: [[6.0, -62.5, 1300, 150], [4.5, -61.0, 1500], [2.5, -63.8, 1300], [1.5, -61.5, 700, 120], [2.5, -58.0, 700], [3.5, -54.5, 500]] },
  { name: 'Serra do Mar–Mantiqueira', pts: [[-20.8, -41.3, 1200, 60], [-22.3, -44.5, 1800, 70], [-23.3, -46.0, 1100, 60], [-25.3, -48.8, 1300, 55], [-27.5, -49.5, 1400, 60], [-29.0, -50.2, 1100]] },
  { name: 'Espinhaço', pts: [[-11.5, -41.5, 1100, 70], [-14.0, -42.3, 1100], [-17.5, -43.5, 1300], [-20.3, -43.8, 1400]] },
  { name: 'Borborema', pts: [[-7.0, -36.3, 700, 120]] },
  // ---------------- Oceania ----------------
  { name: 'Great Dividing Range', pts: [[-11.5, 142.9, 300, 60], [-15.5, 145.0, 800, 80], [-17.5, 145.5, 1000, 90], [-20.0, 146.5, 700, 100], [-23.5, 148.0, 700, 110], [-26.5, 151.3, 800, 100], [-29.0, 152.0, 1100], [-31.0, 151.3, 1200], [-33.5, 150.1, 1000], [-35.5, 148.8, 1300], [-36.6, 147.8, 1600, 90], [-37.3, 146.0, 1100, 80], [-37.4, 143.5, 500, 70], [-37.5, 142.0, 400, 60]] },
  { name: 'MacDonnell', pts: [[-23.6, 131.8, 900, 80], [-23.7, 134.5, 900]] },
  { name: 'Musgrave', pts: [[-26.2, 130.5, 900, 90], [-26.1, 132.5, 800, 80]] },
  { name: 'Hamersley', pts: [[-22.4, 116.5, 900, 110], [-22.6, 119.5, 800, 100]] },
  { name: 'Kimberley', pts: [[-16.5, 126.0, 600, 180]] },
  { name: 'Flinders', pts: [[-31.0, 138.8, 700, 70], [-32.5, 138.3, 700, 60]] },
  { name: 'Arnhem Land', pts: [[-13.0, 134.0, 300, 150]] },
  { name: 'Tasmania', pts: [[-41.3, 146.0, 900, 60], [-42.3, 146.2, 1000], [-43.0, 146.6, 700, 50]] },
  { name: 'Southern Alps', pts: [[-40.8, 172.6, 1300, 50], [-42.0, 172.5, 1800], [-43.2, 171.0, 2100, 55], [-44.3, 169.5, 2000], [-45.3, 168.2, 1600], [-46.0, 167.3, 1000, 45]] },
  { name: 'North Island ranges', pts: [[-37.6, 176.2, 600, 40], [-39.2, 175.6, 1300, 50], [-40.3, 175.9, 900, 40], [-41.2, 175.3, 800, 30]] },
  // ---------------- Polar ----------------
  { name: 'Antarctic Peninsula', pts: [[-63.5, -58.5, 1200, 60], [-65.5, -62.5, 1600, 80], [-68.0, -65.5, 1800, 100], [-70.5, -67.0, 1800], [-73.5, -70.5, 1500, 120]] },
  { name: 'Ellsworth', pts: [[-78.5, -86.0, 2800, 110]] },
  { name: 'Transantarctic', pts: [[-71.5, 168.5, 2400, 110], [-74.0, 163.5, 2400], [-77.0, 161.0, 2200], [-79.5, 158.0, 2200], [-82.0, 162.0, 2600, 120], [-84.0, 170.0, 3000, 130], [-85.3, 182.0, 3200], [-86.0, 200.0, 3000, 120], [-86.2, 215.0, 2800, 100]] },
  { name: 'East Greenland mountains', pts: [[72.0, -25.0, 1800, 90], [69.0, -29.5, 2200, 100], [66.5, -36.5, 1800, 90]] },
];

/** Plateaus and high basins (absolute heights, m). */
const PLATEAUS: readonly PlateauDef[] = [
  { name: 'Tibetan Plateau', h: 4700, edge: 160, poly: [[35.8, 75.5], [36.2, 78.5], [36.0, 84.0], [35.9, 89.5], [35.6, 94.0], [35.2, 98.0], [35.0, 101.5], [34.0, 103.2], [32.0, 102.8], [30.0, 101.8], [28.3, 100.3], [27.5, 98.8], [28.3, 97.0], [28.5, 94.5], [28.2, 92.0], [28.0, 89.5], [28.2, 86.5], [28.8, 84.0], [29.8, 81.5], [31.3, 79.3], [33.0, 77.8], [34.8, 76.0]] },
  { name: 'Qaidam Basin', h: 2900, edge: 100, poly: [[38.3, 90.5], [38.8, 93.5], [38.0, 97.0], [37.0, 99.0], [36.4, 97.5], [36.6, 93.0], [37.2, 90.8]] },
  { name: 'Tarim Basin', h: 1150, edge: 150, poly: [[41.3, 75.5], [41.6, 79.5], [42.0, 84.5], [41.2, 88.5], [40.0, 90.5], [38.8, 89.0], [37.5, 85.0], [37.2, 80.5], [38.3, 76.5], [39.8, 75.0]] },
  { name: 'Mongolian Plateau', h: 1400, edge: 250, poly: [[50.5, 89.0], [51.0, 95.0], [50.5, 101.0], [50.0, 106.0], [49.5, 112.0], [47.5, 118.0], [45.0, 117.5], [43.0, 114.0], [42.0, 109.0], [41.5, 104.0], [42.0, 98.0], [43.5, 93.0], [46.0, 90.0], [48.5, 88.0]] },
  { name: 'Loess Plateau', h: 1300, edge: 180, poly: [[38.8, 103.5], [39.8, 107.0], [39.2, 111.0], [37.0, 112.8], [35.0, 111.5], [34.4, 107.0], [35.0, 104.0], [36.8, 102.5]] },
  { name: 'Yunnan Plateau', h: 2000, edge: 160, poly: [[27.8, 99.5], [27.5, 103.3], [25.5, 104.5], [23.3, 104.0], [22.8, 101.5], [24.0, 99.3]] },
  { name: 'Guizhou Plateau', h: 1100, edge: 160, poly: [[28.5, 104.0], [28.0, 108.0], [26.0, 109.0], [24.8, 107.5], [25.2, 104.5], [27.0, 103.5]] },
  { name: 'Central Siberian Plateau', h: 650, edge: 350, poly: [[72.0, 94.0], [71.5, 103.0], [70.0, 110.0], [67.0, 114.0], [63.0, 113.5], [60.0, 108.0], [58.5, 101.0], [60.0, 93.0], [64.0, 88.5], [68.5, 87.5]] },
  { name: 'Aldan Highlands', h: 900, edge: 200, poly: [[60.0, 121.0], [59.5, 132.0], [57.0, 132.0], [56.5, 121.0]] },
  { name: 'Anatolian Plateau', h: 1100, edge: 150, poly: [[40.2, 29.0], [40.8, 33.0], [40.4, 38.0], [40.0, 40.5], [38.6, 40.5], [37.5, 37.5], [37.2, 33.5], [37.8, 30.0], [39.0, 28.5]] },
  { name: 'Armenian Highland', h: 1800, edge: 150, poly: [[41.0, 40.0], [41.2, 44.0], [40.5, 46.5], [39.0, 46.5], [38.0, 44.5], [38.3, 40.5]] },
  { name: 'Iranian Plateau', h: 1100, edge: 180, poly: [[38.0, 46.5], [37.0, 50.0], [36.5, 55.0], [37.0, 60.0], [35.0, 61.3], [31.0, 61.5], [28.5, 60.0], [28.2, 57.5], [29.5, 53.5], [32.0, 50.5], [34.5, 47.5], [36.5, 46.0]] },
  { name: 'Afghan highlands', h: 2200, edge: 170, poly: [[36.2, 64.5], [36.3, 69.0], [35.5, 71.0], [34.0, 70.8], [32.5, 69.0], [31.5, 66.5], [32.5, 63.5], [34.5, 63.0]] },
  { name: 'Deccan Plateau', h: 650, edge: 200, poly: [[23.3, 73.5], [23.5, 82.0], [21.5, 84.5], [18.5, 83.0], [15.0, 79.8], [12.5, 78.3], [10.8, 77.5], [12.5, 75.5], [15.5, 74.5], [19.0, 73.8], [21.5, 73.5]] },
  { name: 'Shan Plateau', h: 1000, edge: 120, poly: [[25.5, 97.5], [24.5, 100.3], [21.5, 101.0], [19.5, 99.0], [20.5, 96.8], [23.0, 96.5]] },
  { name: 'Iberian Meseta', h: 700, edge: 150, poly: [[43.0, -7.5], [42.5, -3.0], [41.5, -1.8], [39.5, -2.0], [38.3, -3.5], [38.3, -6.8], [39.8, -7.3], [41.5, -8.0]] },
  { name: 'Iceland', h: 500, edge: 60, poly: [[66.3, -23.0], [66.4, -16.5], [65.7, -14.0], [64.5, -14.3], [63.6, -17.5], [63.7, -21.5], [64.6, -22.0], [65.5, -23.5]] },
  { name: 'Ethiopian Highlands', h: 2300, edge: 160, poly: [[15.3, 38.6], [14.2, 39.6], [12.5, 39.8], [10.0, 39.9], [8.8, 39.3], [7.0, 38.4], [5.5, 37.5], [5.5, 36.5], [7.0, 35.6], [9.0, 35.3], [11.0, 36.0], [13.0, 37.0], [14.5, 37.8]] },
  { name: 'Somali Plateau', h: 1600, edge: 180, poly: [[9.8, 40.8], [9.7, 43.0], [9.0, 45.0], [7.5, 45.0], [6.0, 43.5], [5.5, 41.5], [6.5, 40.3], [8.3, 40.2]] },
  { name: 'East African Plateau', h: 1250, edge: 200, poly: [[3.5, 31.0], [4.2, 34.5], [3.0, 37.0], [1.0, 38.3], [-2.0, 38.3], [-5.0, 37.6], [-8.0, 36.0], [-10.5, 34.2], [-11.5, 33.0], [-9.0, 30.8], [-6.0, 29.6], [-3.0, 29.2], [0.0, 29.7], [2.0, 30.5]] },
  { name: 'Southern African Plateau', h: 1100, edge: 220, poly: [[-11.5, 13.8], [-11.0, 19.0], [-12.0, 24.0], [-12.0, 28.0], [-10.5, 31.5], [-13.0, 33.0], [-16.5, 32.5], [-19.5, 32.3], [-22.5, 31.0], [-25.0, 30.8], [-27.5, 30.2], [-30.0, 29.0], [-31.8, 27.0], [-32.3, 23.5], [-32.0, 20.0], [-29.5, 17.8], [-26.0, 16.3], [-22.0, 15.0], [-18.0, 13.5], [-14.5, 13.2]] },
  { name: 'Highveld', h: 1600, edge: 150, poly: [[-24.3, 26.5], [-24.5, 30.0], [-26.5, 30.4], [-28.5, 29.8], [-29.5, 28.0], [-28.3, 25.8], [-26.0, 25.5]] },
  { name: 'Brazilian Highlands', h: 850, edge: 280, poly: [[-7.5, -48.0], [-7.0, -43.0], [-8.5, -39.5], [-11.0, -38.8], [-14.5, -40.0], [-18.5, -41.0], [-21.5, -42.5], [-23.8, -46.0], [-25.8, -49.0], [-28.5, -50.5], [-30.3, -53.0], [-29.5, -55.5], [-26.5, -54.0], [-23.0, -52.5], [-20.0, -51.5], [-17.5, -53.5], [-15.5, -56.0], [-13.5, -55.5], [-12.5, -52.0], [-10.0, -50.0]] },
  { name: 'Planalto Central', h: 1150, edge: 150, poly: [[-13.0, -48.5], [-14.0, -46.0], [-17.0, -46.5], [-18.0, -48.5], [-16.0, -50.0]] },
  { name: 'Mexican Plateau', h: 1700, edge: 150, poly: [[31.2, -107.5], [31.0, -104.5], [28.5, -102.8], [25.8, -101.0], [23.0, -100.2], [21.0, -99.6], [19.8, -99.0], [19.5, -100.5], [20.8, -102.8], [22.5, -103.8], [25.0, -105.3], [28.0, -106.8]] },
  { name: 'Colorado Plateau', h: 1900, edge: 140, poly: [[40.2, -111.0], [40.0, -107.5], [37.8, -106.8], [35.3, -107.3], [34.5, -110.0], [35.3, -112.8], [36.3, -113.8], [37.8, -113.2], [39.3, -111.7]] },
  { name: 'Great Basin', h: 1500, edge: 150, poly: [[43.2, -120.5], [43.5, -117.5], [42.5, -113.5], [41.5, -112.0], [39.0, -112.3], [37.0, -113.6], [35.8, -115.0], [36.5, -116.8], [37.8, -118.5], [40.0, -120.2]] },
  { name: 'Wyoming Basin', h: 2000, edge: 150, poly: [[43.0, -109.5], [43.0, -106.5], [41.0, -106.3], [41.0, -110.0]] },
  { name: 'Snake River Plain', h: 1300, edge: 80, poly: [[44.0, -117.0], [44.3, -112.0], [43.0, -111.7], [42.5, -115.0], [43.2, -117.0]] },
  { name: 'Columbia Plateau', h: 600, edge: 100, poly: [[48.0, -120.3], [47.5, -117.0], [46.0, -116.8], [44.8, -119.0], [45.5, -121.0], [47.0, -121.0]] },
  { name: 'Interior Plateau (BC)', h: 1100, edge: 100, poly: [[56.5, -125.5], [55.0, -122.0], [52.0, -120.0], [50.0, -118.8], [49.2, -120.0], [50.3, -122.0], [52.5, -124.5], [55.0, -127.0]] },
  { name: 'Yukon Plateau', h: 900, edge: 150, poly: [[66.0, -143.0], [64.8, -136.0], [62.0, -131.5], [60.2, -134.5], [61.0, -140.0], [63.5, -145.5]] },
  { name: 'Altiplano', h: 3900, edge: 110, poly: [[-14.5, -71.3], [-15.2, -69.0], [-17.0, -67.3], [-19.5, -66.3], [-22.3, -66.0], [-24.3, -66.8], [-25.5, -68.0], [-24.0, -68.7], [-21.5, -68.8], [-18.8, -69.4], [-16.5, -71.0]] },
  { name: 'Patagonian Plateau', h: 700, edge: 150, poly: [[-38.0, -70.0], [-38.3, -67.0], [-41.5, -65.5], [-44.5, -67.3], [-47.0, -67.5], [-50.0, -69.0], [-51.8, -70.2], [-51.8, -72.0], [-47.5, -71.8], [-43.0, -71.3], [-40.0, -70.8]] },
];

/** Regional base heights of lowlands and interior platforms: [lat, lon, height m, radius km]. */
const BASE_ANCHORS: ReadonlyArray<readonly [number, number, number, number]> = [
  // North America
  [60, -100, 350, 900], [57, -85, 100, 450], [52, -106, 600, 400], [51, -113, 1000, 300],
  [40, -100, 800, 400], [39, -103.5, 1500, 250], [33, -101, 950, 300], [38, -90, 200, 450],
  [42, -85, 250, 400], [32, -85, 150, 400], [30, -97, 200, 300], [66, -150, 350, 400],
  [70, -100, 150, 800], [48, -75, 350, 300], [47, -95, 400, 300],
  [48, -108, 950, 350], [53.5, -115, 850, 250], [53, -68, 550, 400], [69, -72, 500, 300], [75, -100, 250, 450],
  [60, -100, 400, 500],
  // South America
  [-5, -62, 100, 1000], [-19, -57, 120, 300], [-33, -62, 80, 500], [-25, -61, 200, 400], [8, -66, 100, 400],
  [4, -59, 400, 450],
  [-32.5, -68.3, 800, 180],
  // Europe
  [52, 25, 150, 900], [56, 45, 150, 800], [48, 10, 450, 300], [60, 15, 300, 400], [45, 47, 5, 300],
  // Asia
  [60, 75, 100, 900], [48, 70, 350, 700], [41, 62, 150, 500], [45, 125, 200, 400], [35, 116, 50, 350],
  [30, 113, 100, 400], [30.5, 105.5, 450, 250], [26, 86, 80, 400], [28, 78, 220, 400], [24, 70, 150, 400],
  [16, 102, 180, 400], [25, 45, 700, 700], [33, 43, 50, 350], [70, 150, 50, 500], [63, 130, 200, 300],
  [65, 145, 700, 450], [62, 165, 600, 400], [26, 112, 450, 400], [20, 102, 700, 300], [45, 110, 1000, 400],
  // Africa
  [22, 10, 450, 1200], [27, 28, 200, 500], [30, 17, 150, 400], [0, 21, 400, 700], [13, 0, 300, 700],
  [10, 30, 450, 500], [-22, 22, 1000, 600], [12.5, 41.5, 300, 150], [6, 20, 600, 450],
  // Australia
  [-25, 125, 400, 900], [-28, 138, 60, 400], [-22, 142, 250, 500], [-32, 145, 150, 400],
];
/** Base height where no anchor dominates (m). */
const DEFAULT_BASE = 450;
/** Weight of DEFAULT_BASE in the anchor blend. */
const DEFAULT_BASE_WEIGHT = 0.05;

/** Epicontinental shallow seas (depth, m). Applied to ocean samples only. */
const SHALLOW_SEAS: readonly PlateauDef[] = [
  { name: 'Sunda Shelf', h: -60, edge: 150, poly: [[14.0, 100.0], [10.0, 106.0], [6.0, 108.0], [3.0, 112.0], [-1.0, 118.5], [-5.0, 119.0], [-8.5, 115.5], [-8.5, 105.0], [-5.5, 101.0], [0.0, 98.0], [5.0, 97.0], [8.0, 98.0]] },
  { name: 'Sahul Shelf', h: -70, edge: 150, poly: [[-8.0, 133.0], [-8.8, 138.0], [-9.2, 142.0], [-10.5, 143.0], [-17.5, 141.5], [-16.5, 137.5], [-14.5, 135.5], [-12.0, 131.5], [-12.5, 128.0], [-14.0, 125.5], [-15.5, 123.0], [-13.5, 122.5], [-11.5, 125.5], [-10.2, 128.5], [-9.0, 131.0]] },
  { name: 'East China & Yellow Seas', h: -60, edge: 150, poly: [[41.0, 121.5], [39.0, 125.0], [37.0, 126.5], [34.5, 126.5], [33.0, 128.5], [30.5, 127.0], [27.5, 124.5], [25.0, 121.5], [26.5, 120.0], [30.0, 122.0], [32.0, 121.0], [35.0, 119.5], [37.0, 119.0], [38.5, 117.5], [40.0, 119.5]] },
  { name: 'Persian Gulf', h: -45, edge: 60, poly: [[30.5, 48.0], [29.0, 51.0], [26.8, 56.5], [25.5, 56.8], [24.0, 53.5], [24.0, 51.5], [26.5, 50.0], [28.5, 48.5]] },
  { name: 'North Sea', h: -70, edge: 120, poly: [[61.5, 1.0], [60.0, 5.0], [58.0, 7.5], [56.5, 8.3], [53.5, 8.5], [53.0, 5.0], [51.0, 2.0], [51.0, 1.0], [53.0, 0.5], [55.5, -1.5], [57.5, -2.0], [59.0, -3.0], [60.5, -1.5]] },
  { name: 'Baltic Sea', h: -55, edge: 80, poly: [[65.8, 22.0], [64.0, 25.0], [60.5, 29.5], [59.5, 29.0], [57.5, 24.0], [55.0, 21.0], [54.3, 18.0], [54.0, 14.0], [54.5, 10.0], [56.5, 10.5], [57.5, 12.0], [59.0, 17.5], [61.0, 17.5], [63.5, 19.5]] },
  { name: 'Celtic & Irish Seas', h: -80, edge: 120, poly: [[51.0, 1.5], [49.3, -0.5], [48.5, -5.0], [50.5, -7.5], [52.0, -6.5], [54.5, -5.5], [55.3, -5.0], [54.0, -3.0], [53.3, -3.0], [51.5, -3.0], [50.5, -1.0]] },
  { name: 'North Adriatic', h: -50, edge: 80, poly: [[45.8, 13.0], [45.5, 13.8], [43.0, 16.0], [42.0, 15.5], [43.5, 13.5], [44.5, 12.3]] },
  { name: 'Siberian Arctic Shelf', h: -120, edge: 250, poly: [[77.5, 20.0], [79.5, 45.0], [80.0, 70.0], [79.5, 95.0], [78.0, 120.0], [76.5, 140.0], [75.0, 160.0], [74.0, 180.0], [72.5, 195.0], [72.5, 203.0], [71.0, 204.0], [69.5, 195.0], [69.0, 170.0], [71.0, 150.0], [72.5, 130.0], [73.5, 110.0], [73.0, 90.0], [71.0, 70.0], [69.5, 55.0], [70.5, 40.0], [71.0, 25.0], [74.0, 17.0]] },
  { name: 'Bering Shelf', h: -70, edge: 200, poly: [[66.0, 188.0], [64.5, 194.0], [60.0, 197.0], [58.5, 202.0], [56.0, 196.0], [57.0, 190.0], [60.0, 182.0], [62.5, 180.0], [64.5, 182.5]] },
  { name: 'Hudson Bay', h: -110, edge: 120, poly: [[64.5, -88.0], [62.5, -80.0], [60.0, -77.0], [55.0, -76.5], [51.5, -79.5], [54.0, -84.0], [56.0, -88.5], [58.8, -94.5], [61.5, -94.0], [63.5, -92.0]] },
  { name: 'Grand Banks & Scotian Shelf', h: -80, edge: 120, poly: [[47.5, -52.5], [45.0, -49.0], [43.0, -50.5], [42.5, -64.0], [43.5, -66.5], [45.5, -61.0], [46.8, -57.5]] },
  { name: 'Patagonian Shelf', h: -100, edge: 150, poly: [[-36.0, -56.5], [-40.0, -57.5], [-45.0, -59.5], [-50.0, -61.0], [-54.5, -63.5], [-55.0, -66.5], [-52.5, -69.0], [-48.0, -66.0], [-43.0, -64.0], [-39.0, -61.5]] },
  { name: 'Campeche Bank', h: -50, edge: 80, poly: [[21.5, -91.5], [22.5, -89.5], [21.8, -87.0], [20.0, -90.5]] },
  { name: 'Bass Strait', h: -60, edge: 60, poly: [[-38.3, 144.0], [-38.5, 147.5], [-40.5, 148.5], [-40.8, 144.5]] },
];

/** Mid-ocean ridges: [lat, lon, crest depth m?, half-width km?] (flank subsidence ∝ √distance). */
const RIDGES: readonly RangeDef[] = [
  { name: 'Mid-Atlantic Ridge', pts: [[63.0, -24.5, -1500, 700], [60.0, -30.0, -2300, 900], [56.0, -34.0, -2500], [52.5, -31.0], [48.0, -28.0], [44.0, -28.5], [40.0, -29.5, -2000], [36.0, -33.5, -2500], [33.0, -38.5], [29.0, -43.0], [24.0, -45.5], [19.0, -46.0], [14.0, -45.0], [11.0, -42.0], [8.0, -37.5], [4.0, -32.0], [1.0, -27.0], [0.0, -20.0], [-1.5, -14.5], [-5.0, -12.0], [-10.0, -13.5], [-16.0, -14.0], [-22.0, -13.0], [-27.0, -13.2], [-33.0, -14.5], [-38.0, -16.5], [-42.0, -16.5], [-46.0, -13.5], [-50.0, -8.0], [-53.5, -2.0], [-54.5, 0.0]] },
  { name: 'Kolbeinsey–Mohns–Knipovich', pts: [[67.5, -18.5, -2000, 350], [71.0, -8.0, -2500], [73.0, 3.0], [75.0, 8.0], [78.5, 7.0], [80.5, 0.0]] },
  { name: 'Gakkel Ridge', pts: [[84.0, 0.0, -3500, 250], [86.0, 40.0], [87.0, 80.0], [86.0, 120.0]] },
  { name: 'Southwest Indian Ridge', pts: [[-54.5, 0.0, -3000, 900], [-53.5, 10.0], [-51.5, 20.0], [-47.5, 31.0], [-43.5, 40.0], [-39.0, 47.0], [-35.0, 53.5], [-30.0, 60.0], [-26.0, 68.0], [-25.5, 70.0]] },
  { name: 'Central Indian & Carlsberg Ridges', pts: [[-25.5, 70.0, -2800, 1000], [-20.0, 66.5], [-13.0, 66.3], [-6.0, 68.0], [-1.0, 67.5], [3.0, 63.5], [7.0, 60.0], [10.0, 57.5], [13.0, 51.5, -2500, 350], [12.2, 46.0], [12.5, 44.0]] },
  { name: 'Southeast Indian Ridge', pts: [[-25.5, 70.0, -2700, 1300], [-30.0, 75.0], [-37.0, 78.5, -2000], [-42.0, 86.0, -2700], [-46.0, 95.0], [-49.0, 110.0], [-50.0, 120.0], [-50.5, 130.0], [-53.0, 140.0], [-58.0, 150.0], [-61.5, 158.0]] },
  { name: 'Pacific–Antarctic Ridge', pts: [[-61.5, 158.0, -2700, 1300], [-63.0, 170.0], [-64.5, 182.0], [-64.0, 195.0], [-60.0, 207.0], [-56.0, 215.0], [-53.0, 226.0, -2600, 1600], [-47.0, 245.0], [-40.0, 249.0], [-35.0, 250.0]] },
  { name: 'East Pacific Rise', pts: [[-35.0, -110.0, -2600, 1800], [-30.0, -112.0], [-25.0, -113.0], [-20.0, -113.5], [-15.0, -112.8], [-10.0, -110.5], [-5.0, -106.5], [0.0, -102.5], [5.0, -103.5], [10.0, -104.0, -2600, 1300], [15.0, -105.0], [19.0, -108.5, -2600, 600], [23.0, -108.8]] },
  { name: 'Chile Rise', pts: [[-35.5, -109.5, -2800, 800], [-37.0, -100.0], [-40.0, -92.0], [-43.0, -85.0], [-46.0, -76.5]] },
  { name: 'Galápagos Rise', pts: [[2.2, -102.0, -2500, 350], [1.5, -95.0], [1.8, -85.0]] },
  { name: 'Juan de Fuca–Gorda', pts: [[50.5, -130.5, -2400, 300], [47.0, -129.0], [44.0, -129.5], [41.0, -127.5]] },
];

/** Ocean trenches: [lat, lon, axis depth m?, half-width km?]. Deepen only the deep ocean. */
const TRENCHES: readonly RangeDef[] = [
  { name: 'Aleutian', pts: [[50.5, 170.0, -6500, 70], [50.8, 178.0], [51.0, 185.0], [51.5, 195.0], [53.0, 202.0], [55.5, 207.0], [57.5, 211.0, -5000]] },
  { name: 'Kuril–Kamchatka', pts: [[55.0, 163.5, -6500, 70], [51.0, 159.5, -8000], [47.0, 155.0, -9000], [44.0, 150.0], [41.5, 144.5, -7500]] },
  { name: 'Japan–Izu–Bonin', pts: [[41.5, 144.5, -7500, 70], [38.0, 144.0, -8000], [34.5, 142.0, -9000], [30.0, 142.5], [25.0, 143.0, -8500]] },
  { name: 'Mariana', pts: [[24.0, 143.5, -8000, 70], [20.0, 146.8], [16.0, 147.8, -9000], [13.0, 146.8], [11.3, 142.5, -10500], [10.5, 140.0, -8000]] },
  { name: 'Philippine', pts: [[14.0, 127.0, -8000, 60], [9.0, 126.8, -10000], [5.5, 127.0, -7500]] },
  { name: 'Ryukyu', pts: [[24.0, 123.0, -6500, 60], [26.0, 128.5], [30.0, 132.0, -5500]] },
  { name: 'Sunda', pts: [[2.0, 95.5, -5500, 70], [-2.0, 98.5, -6000], [-6.0, 102.0, -6500], [-9.5, 107.0, -7000], [-11.0, 113.0, -7000], [-11.0, 118.0, -6500], [-10.5, 121.0, -5500]] },
  { name: 'Tonga–Kermadec', pts: [[-15.0, 187.0, -8000, 70], [-20.0, 186.5, -10000], [-25.0, 185.5, -9000], [-30.0, 183.0, -9500], [-35.0, 181.0, -8000], [-38.0, 179.0, -6500]] },
  { name: 'Peru–Chile', pts: [[-3.0, -81.5, -5000, 70], [-8.0, -80.5, -6000], [-12.0, -78.5, -6500], [-16.0, -75.0, -6500], [-19.0, -71.5, -7000], [-23.0, -71.0, -7500], [-28.0, -71.8, -7000], [-33.0, -72.5, -6000], [-38.0, -74.5, -5000], [-44.0, -76.0, -4500]] },
  { name: 'Middle America', pts: [[20.0, -106.5, -5000, 60], [16.5, -100.0, -5500], [14.5, -94.5, -6000], [12.0, -90.0, -6000], [10.0, -87.0, -5000]] },
  { name: 'Puerto Rico', pts: [[19.8, -68.0, -7500, 50], [19.8, -64.0, -8000], [18.5, -61.5, -6000]] },
  { name: 'South Sandwich', pts: [[-55.0, -27.5, -7000, 45], [-57.5, -25.0, -8000], [-60.0, -26.5, -6500]] },
];

/** Generous outline around Greenland (excludes Ellesmere across Nares Strait, Iceland, Svalbard). */
const GREENLAND_OUTLINE: readonly LatLon[] = [
  [83.8, -30.0], [83.0, -55.0], [82.3, -61.5], [81.2, -64.5], [80.3, -68.0], [79.2, -71.5], [78.2, -73.5],
  [76.0, -72.0], [74.0, -60.0], [70.0, -56.5], [66.0, -55.0], [61.0, -50.0], [59.5, -45.0], [60.5, -42.0],
  [65.0, -38.0], [68.0, -30.0], [70.0, -21.0], [74.0, -17.0], [77.0, -16.0], [80.0, -10.0], [82.5, -12.0],
];

/* ================================================================== */
/* 3b. Relief primitives                                               */
/* ================================================================== */

/** Kind of contribution; decides which row buffer a feature writes. */
const KIND_LAND = 0;
const KIND_RIDGE = 1;
const KIND_TRENCH = 2;

/** One straight piece of a polyline feature (capsule with linearly varying height & width). */
interface Capsule {
  kind: number;
  lat0: number; lon0: number; lat1: number; lon1: number;
  h0: number; h1: number; w0: number; w1: number;
  latMin: number; latMax: number; lonMin: number; lonMax: number; wMax: number;
}

interface Polygon {
  h: number;
  edge: number;
  /** Flat [lat, lon, ...] with unwrapped longitudes. */
  pts: Float64Array;
  latMin: number; latMax: number; lonMin: number; lonMax: number;
}

function capsulesOf(def: RangeDef, kind: number): Capsule[] {
  const out: Capsule[] = [];
  const pts = def.pts;
  let h = pts[0][2];
  let wd = pts[0][3];
  if (h === undefined || wd === undefined) throw new Error(`relief feature ${def.name}: first vertex needs height and width`);
  const full: Array<[number, number, number, number]> = [];
  for (const p of pts) {
    if (p[2] !== undefined) h = p[2];
    if (p[3] !== undefined) wd = p[3];
    full.push([p[0], p[1], h, wd]);
  }
  const n = full.length === 1 ? 1 : full.length - 1;
  for (let i = 0; i < n; i++) {
    const a = full[i];
    const b = full[Math.min(i + 1, full.length - 1)];
    const wMax = Math.max(a[3], b[3]);
    out.push({
      kind, lat0: a[0], lon0: a[1], lat1: b[0], lon1: b[1], h0: a[2], h1: b[2], w0: a[3], w1: b[3],
      latMin: Math.min(a[0], b[0]) - wMax / KM_PER_DEG, latMax: Math.max(a[0], b[0]) + wMax / KM_PER_DEG,
      lonMin: Math.min(a[1], b[1]), lonMax: Math.max(a[1], b[1]), wMax,
    });
  }
  return out;
}

function polygonOf(def: PlateauDef): Polygon {
  const pts = new Float64Array(def.poly.length * 2);
  let latMin = 90, latMax = -90, lonMin = Infinity, lonMax = -Infinity;
  def.poly.forEach(([la, lo], i) => {
    pts[2 * i] = la;
    pts[2 * i + 1] = lo;
    latMin = Math.min(latMin, la); latMax = Math.max(latMax, la);
    lonMin = Math.min(lonMin, lo); lonMax = Math.max(lonMax, lo);
  });
  const m = def.edge / 2 / KM_PER_DEG;
  return { h: def.h, edge: def.edge, pts, latMin: latMin - m, latMax: latMax + m, lonMin, lonMax };
}

/** Smooth bump for mountain cross-sections: 1 at the crest, 0 with zero slope at u = 1. */
const bump = (u: number): number => {
  const q = 1 - u * u;
  return q * q;
};
/** Polynomial smooth maximum (blend width k). */
function smax(a: number, b: number, k: number): number {
  const d = Math.abs(a - b);
  if (d >= k) return a > b ? a : b;
  const t = (k - d) / k;
  return (a > b ? a : b) + t * t * k * 0.25;
}
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Distance (km) from (lat, lon) to a segment, in a local equirectangular frame centred on the sample
 * (accurate where it matters: within a few hundred km). Returns the segment parameter in `tOut[0]`.
 */
function segmentDistanceKm(
  lat: number, lon: number, cosLat: number,
  lat0: number, lon0: number, lat1: number, lon1: number, tOut: Float64Array,
): number {
  const ax = (lon0 - lon) * cosLat, ay = lat0 - lat;
  const bx = (lon1 - lon) * cosLat, by = lat1 - lat;
  const ex = bx - ax, ey = by - ay;
  const len2 = ex * ex + ey * ey;
  let t = len2 > 0 ? -(ax * ex + ay * ey) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  tOut[0] = t;
  const px = ax + t * ex, py = ay + t * ey;
  return Math.sqrt(px * px + py * py) * KM_PER_DEG;
}

/** Signed distance (km, > 0 inside) from a sample to a polygon (even–odd, local projection). */
function polygonSignedDistanceKm(lat: number, lon: number, cosLat: number, pts: Float64Array, tmp: Float64Array): number {
  const n = pts.length >> 1;
  let inside = false;
  let dMin = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const la0 = pts[2 * j], lo0 = pts[2 * j + 1];
    const la1 = pts[2 * i], lo1 = pts[2 * i + 1];
    if ((la1 > lat) !== (la0 > lat) && lon < lo0 + ((lat - la0) * (lo1 - lo0)) / (la1 - la0)) inside = !inside;
    const d = segmentDistanceKm(lat, lon, cosLat, la0, lo0, la1, lo1, tmp);
    if (d < dMin) dMin = d;
  }
  return inside ? dMin : -dMin;
}

/** Vialov (1958) ice-sheet profile: height at distance d inland from the margin of a sheet of half-width L. */
function vialov(d: number, H: number, L: number): number {
  const x = 1 - Math.min(d, L) / L;
  return H * Math.pow(Math.max(0, 1 - Math.pow(x, 4 / 3)), 3 / 8);
}

/* ================================================================== */
/* 3c. Smooth large-scale fields (coarse grid)                         */
/* ================================================================== */

/** Coarse (0.5°) fields sampled bilinearly: lowland base height and abyssal-floor depth. */
interface CoarseFields {
  cw: number;
  ch: number;
  base: Float32Array;
  abyss: Float32Array;
}

let coarseCache: CoarseFields | null = null;

function coarseFields(): CoarseFields {
  if (coarseCache) return coarseCache;
  const cw = 720, ch = 360;
  const base = new Float32Array(cw * ch);
  const abyss = new Float32Array(cw * ch);
  const noise = createNoise3(90210);
  const ax = BASE_ANCHORS.map(([la, lo]) => [Math.cos(la * DEG) * Math.cos(lo * DEG), Math.cos(la * DEG) * Math.sin(lo * DEG), Math.sin(la * DEG)]);
  for (let r = 0; r < ch; r++) {
    const lat = 90 - (r + 0.5) * (180 / ch);
    const cl = Math.cos(lat * DEG), sl = Math.sin(lat * DEG);
    for (let c = 0; c < cw; c++) {
      const lon = -180 + (c + 0.5) * (360 / cw);
      const x = cl * Math.cos(lon * DEG), y = cl * Math.sin(lon * DEG), z = sl;
      let sw = DEFAULT_BASE_WEIGHT, sh = DEFAULT_BASE_WEIGHT * DEFAULT_BASE;
      for (let k = 0; k < BASE_ANCHORS.length; k++) {
        const a = ax[k];
        const dot = Math.min(1, Math.max(-1, x * a[0] + y * a[1] + z * a[2]));
        const d = Math.acos(dot) * EARTH_RADIUS_KM;
        const rad = BASE_ANCHORS[k][3];
        if (d > 3 * rad) continue;
        const wgt = Math.exp(-(d * d) / (rad * rad));
        sw += wgt;
        sh += wgt * BASE_ANCHORS[k][2];
      }
      base[r * cw + c] = sh / sw;
      // Abyssal plain depth: −4800 m ± 350 m of long-wavelength relief.
      abyss[r * cw + c] = -4800 + 350 * fbm3(noise, 2.5 * x, 2.5 * y, 2.5 * z, 4);
    }
  }
  coarseCache = { cw, ch, base, abyss };
  return coarseCache;
}

/** Bilinear sample (lon-wrapping) of a coarse field at (lat, lon) degrees. */
function sampleCoarse(f: Float32Array, cw: number, ch: number, lat: number, lon: number): number {
  let fr = ((90 - lat) / 180) * ch - 0.5;
  if (fr < 0) fr = 0;
  else if (fr > ch - 1) fr = ch - 1;
  let fc = ((lon + 180) / 360) * cw - 0.5;
  fc -= cw * Math.floor(fc / cw);
  const r0 = Math.floor(fr), r1 = Math.min(ch - 1, r0 + 1), tr = fr - r0;
  const c0 = Math.floor(fc) % cw, c1 = (c0 + 1) % cw, tc = fc - Math.floor(fc);
  const a = f[r0 * cw + c0], b = f[r0 * cw + c1], c = f[r1 * cw + c0], d = f[r1 * cw + c1];
  return (a * (1 - tc) + b * tc) * (1 - tr) + (c * (1 - tc) + d * tc) * tr;
}

/* ================================================================== */
/* 3d. Elevation composition, row by row                               */
/* ================================================================== */

/** Coastal ramp: land rises from COAST_HEIGHT to the regional base over this distance (km). */
const COAST_RAMP_KM = 200;
const COAST_HEIGHT = 8;
/** Minimum height of any land sample (m) and maximum height of any ocean sample. */
const MIN_LAND = 2;
const MAX_OCEAN = -5;
/** Default continental shelf: width (km), depth at the shelf break (m), slope width (km). */
const SHELF_KM = 80;
const SHELF_BREAK = -130;
const SLOPE_KM = 170;
/** Smooth-max blend width (m) between overlapping land features. */
const BLEND = 150;

interface ReliefModel {
  capsules: Capsule[];
  plateaus: Polygon[];
  seas: Polygon[];
  greenland: Float64Array;
}

let reliefModel: ReliefModel | null = null;

function getReliefModel(): ReliefModel {
  if (reliefModel) return reliefModel;
  const capsules: Capsule[] = [];
  for (const d of RANGES) capsules.push(...capsulesOf(d, KIND_LAND));
  for (const d of RIDGES) capsules.push(...capsulesOf(d, KIND_RIDGE));
  for (const d of TRENCHES) capsules.push(...capsulesOf(d, KIND_TRENCH));
  const gl = new Float64Array(GREENLAND_OUTLINE.length * 2);
  GREENLAND_OUTLINE.forEach(([la, lo], i) => {
    gl[2 * i] = la;
    gl[2 * i + 1] = lo;
  });
  reliefModel = { capsules, plateaus: PLATEAUS.map(polygonOf), seas: SHALLOW_SEAS.map(polygonOf), greenland: gl };
  return reliefModel;
}

/** Row scratch buffers (length W). */
interface RowBuffers {
  land: Float32Array; // smooth max of land features (−1e9 = none)
  ridge: Float32Array; // max of ridge profiles (−1e9 = none)
  trench: Float32Array; // min of trench offsets (≤ 0)
  seaDepth: Float32Array; // shallow-sea depth
  seaWeight: Float32Array; // shallow-sea weight 0..1
}

/**
 * Unwrapped sample-column span of row features covering [lonMin − m, lonMax + m], limited to one
 * full lap. Column index = mod(cu, W); the sample's unwrapped longitude = −180 + (cu + 0.5)·dLon.
 */
function columnSpan(g: SampleGrid, lonMin: number, lonMax: number, marginDeg: number, out: Int32Array): void {
  let c0 = Math.ceil((lonMin - marginDeg + 180) / g.dLon - 0.5);
  let c1 = Math.floor((lonMax + marginDeg + 180) / g.dLon - 0.5);
  if (c1 - c0 + 1 > g.W) {
    const mid = (c0 + c1) >> 1;
    c0 = mid - (g.W >> 1);
    c1 = c0 + g.W - 1;
  }
  out[0] = c0;
  out[1] = c1;
}

const wrapCol = (cu: number, W: number): number => ((cu % W) + W) % W;

function fillRowFeatures(g: SampleGrid, r: number, mask: Uint8Array, model: ReliefModel, buf: RowBuffers, scratch: { t: Float64Array; span: Int32Array }): void {
  const { W } = g;
  const lat = rowLat(g, r);
  const cosLat = Math.max(0.02, Math.cos(lat * DEG));
  buf.land.fill(-1e9);
  buf.ridge.fill(-1e9);
  buf.trench.fill(0);
  buf.seaDepth.fill(0);
  buf.seaWeight.fill(0);
  const mrow = r * W;
  const tmp = scratch.t;
  const span = scratch.span;

  for (const cp of model.capsules) {
    if (lat < cp.latMin || lat > cp.latMax) continue;
    const wantLand = cp.kind === KIND_LAND ? 1 : 0;
    columnSpan(g, cp.lonMin, cp.lonMax, cp.wMax / (KM_PER_DEG * cosLat), span);
    for (let cu = span[0]; cu <= span[1]; cu++) {
      const col = wrapCol(cu, W);
      if (mask[mrow + col] !== wantLand) continue;
      const lon = -180 + (cu + 0.5) * g.dLon;
      const d = segmentDistanceKm(lat, lon, cosLat, cp.lat0, cp.lon0, cp.lat1, cp.lon1, tmp);
      const t = tmp[0];
      const hw = cp.w0 + t * (cp.w1 - cp.w0);
      if (d >= hw) continue;
      const u = d / hw;
      const crest = cp.h0 + t * (cp.h1 - cp.h0);
      if (cp.kind === KIND_LAND) {
        buf.land[col] = smax(buf.land[col], crest * bump(u), BLEND);
      } else if (cp.kind === KIND_RIDGE) {
        // Depth ∝ √age ∝ √distance from the axis; below the abyss at u = 1 (merged by max later).
        const v = crest - (crest + 5200) * Math.sqrt(u);
        if (v > buf.ridge[col]) buf.ridge[col] = v;
      } else {
        const off = (crest + 4800) * bump(u); // ≤ 0: axis depth relative to a nominal abyss
        if (off < buf.trench[col]) buf.trench[col] = off;
      }
    }
  }

  for (const pl of model.plateaus) {
    if (lat < pl.latMin || lat > pl.latMax) continue;
    columnSpan(g, pl.lonMin, pl.lonMax, pl.edge / 2 / (KM_PER_DEG * cosLat), span);
    for (let cu = span[0]; cu <= span[1]; cu++) {
      const col = wrapCol(cu, W);
      if (mask[mrow + col] !== 1) continue;
      const lon = -180 + (cu + 0.5) * g.dLon;
      const sd = polygonSignedDistanceKm(lat, lon, cosLat, pl.pts, tmp);
      const wgt = smoothstep(0, 1, 0.5 + sd / pl.edge);
      if (wgt > 0) buf.land[col] = smax(buf.land[col], pl.h * wgt, BLEND);
    }
  }

  for (const sea of model.seas) {
    if (lat < sea.latMin || lat > sea.latMax) continue;
    columnSpan(g, sea.lonMin, sea.lonMax, sea.edge / 2 / (KM_PER_DEG * cosLat), span);
    for (let cu = span[0]; cu <= span[1]; cu++) {
      const col = wrapCol(cu, W);
      if (mask[mrow + col] !== 0) continue;
      const lon = -180 + (cu + 0.5) * g.dLon;
      const sd = polygonSignedDistanceKm(lat, lon, cosLat, sea.pts, tmp);
      const wgt = smoothstep(0, 1, 0.5 + sd / sea.edge);
      if (wgt > buf.seaWeight[col]) {
        buf.seaWeight[col] = wgt;
        buf.seaDepth[col] = sea.h;
      }
    }
  }
}

/** Ice-sheet surface height (m) for a land sample, or 0 when not on an ice sheet. */
function iceSheetHeight(lat: number, lon: number, coastKm: number, model: ReliefModel, tmp: Float64Array): number {
  if (lat < -60) {
    // East Antarctica (Dome A ≈ 4000 m) vs the lower, narrower West Antarctic ice sheet.
    const west = smoothstep(-165, -145, lon) * (1 - smoothstep(-75, -55, lon)) * smoothstep(-86, -82, lat);
    const east = vialov(coastKm, 3700, 1300);
    const wais = vialov(coastKm, 2200, 700);
    return east + (wais - east) * west;
  }
  if (lat > 59 && lon > -75 && lon < -10) {
    const cosLat = Math.cos(lat * DEG);
    if (polygonSignedDistanceKm(lat, lon, cosLat, model.greenland, tmp) > 0) return vialov(coastKm, 3200, 500);
  }
  return 0;
}

/** Land elevation (m) of a land sample. */
function landElevation(lat: number, lon: number, coastKm: number, featureHeight: number, cf: CoarseFields, model: ReliefModel, tmp: Float64Array): number {
  const base = sampleCoarse(cf.base, cf.cw, cf.ch, lat, lon);
  const ramped = COAST_HEIGHT + (base - COAST_HEIGHT) * smoothstep(0, COAST_RAMP_KM, coastKm);
  let e = smax(ramped, featureHeight, BLEND);
  const ice = iceSheetHeight(lat, lon, coastKm, model, tmp);
  if (ice > e) e = ice;
  return Math.max(MIN_LAND, e);
}

/** Sea-floor elevation (m) of an ocean sample. */
function oceanElevation(lat: number, lon: number, coastKm: number, col: number, buf: RowBuffers, cf: CoarseFields): number {
  const abyss = sampleCoarse(cf.abyss, cf.cw, cf.ch, lat, lon);
  // Shelf: gently to the shelf break; slope: smooth drop to the abyssal plain.
  let e: number;
  if (coastKm <= SHELF_KM) e = -20 + (SHELF_BREAK + 20) * (coastKm / SHELF_KM);
  else e = SHELF_BREAK + (abyss - SHELF_BREAK) * smoothstep(SHELF_KM, SHELF_KM + SLOPE_KM, coastKm);
  // Mid-ocean ridges raise the floor (never above the shelf profile's own depth near coasts).
  if (buf.ridge[col] > e) e = buf.ridge[col];
  // Epicontinental seas: blend toward their (shallow) depth.
  const sw = buf.seaWeight[col];
  if (sw > 0) {
    const target = buf.seaDepth[col];
    const mixed = e + (target - e) * sw;
    if (mixed > e) e = mixed;
  }
  // Trenches only cut the deep ocean floor.
  if (buf.trench[col] < 0) e += buf.trench[col] * smoothstep(-2500, -4000, e);
  return Math.min(MAX_OCEAN, e);
}

/* ================================================================== */
/* 4. Assembly                                                         */
/* ================================================================== */

interface EarthFields {
  elev: Float32Array;
  landFraction: Float32Array;
}

const resultCache = new Map<string, EarthFields>();

/** Fine-grid land mask & elevation (row-major, row 0 = north). Exposed for previews/diagnostics. */
export interface EarthSampleField {
  W: number;
  H: number;
  land: Uint8Array;
  elev: Float32Array;
  coastKm: Float32Array;
}

/**
 * Build the Earth relief on a W×H sample grid (land mask, elevation, coast distance). The climate
 * input aggregates this; previews may render it directly. W×H should be ≈ 1/8° or finer for good masks.
 */
export function buildEarthSamples(W: number, H: number, withElevation = true): EarthSampleField {
  const g: SampleGrid = { W, H, dLat: 180 / H, dLon: 360 / W };
  const land = rasterizeLand(g, loadLandRings());
  const coastKm = coastDistance(g, land);
  const elev = new Float32Array(W * H);
  if (withElevation) {
    const model = getReliefModel();
    const cf = coarseFields();
    const buf: RowBuffers = {
      land: new Float32Array(W), ridge: new Float32Array(W), trench: new Float32Array(W),
      seaDepth: new Float32Array(W), seaWeight: new Float32Array(W),
    };
    const scratch = { t: new Float64Array(1), span: new Int32Array(2) };
    const tmp = scratch.t;
    for (let r = 0; r < H; r++) {
      fillRowFeatures(g, r, land, model, buf, scratch);
      const lat = rowLat(g, r);
      for (let c = 0; c < W; c++) {
        const i = r * W + c;
        const lon = colLon(g, c);
        elev[i] = land[i]
          ? landElevation(lat, lon, coastKm[i], buf.land[c], cf, model, tmp)
          : oceanElevation(lat, lon, coastKm[i], c, buf, cf);
      }
    }
  }
  return { W, H, land, elev, coastKm };
}

function computeEarth(w: number, h: number): EarthFields {
  const { grid, s } = sampleGridFor(w, h);
  const f = buildEarthSamples(grid.W, grid.H);
  const elev = new Float32Array(w * h);
  const landFraction = new Float32Array(w * h);
  const inv = 1 / (s * s);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let nLand = 0, sumLand = 0, sumSea = 0;
      for (let rr = r * s; rr < (r + 1) * s; rr++) {
        const o = rr * grid.W;
        for (let cc = c * s; cc < (c + 1) * s; cc++) {
          const e = f.elev[o + cc];
          if (f.land[o + cc]) {
            nLand++;
            sumLand += e;
          } else sumSea += e;
        }
      }
      const lf = nLand * inv;
      const i = r * w + c;
      landFraction[i] = lf;
      const nSea = s * s - nLand;
      elev[i] = lf >= 0.5 ? Math.max(1, sumLand / nLand) : Math.min(-1, sumSea / nSea);
    }
  }
  return { elev, landFraction };
}
