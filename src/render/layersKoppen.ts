/**
 * Köppen–Geiger classification per display pixel (SPEC §7 Köppen layer).
 *
 * The Peel et al. (2007) / Beck et al. (2018) decision tree depends on the 12 monthly T / P values
 * only through a few statistics: warmest / coldest month, annual mean, 4th-warmest month (≥ 4 months
 * above 10 °C), annual total, aridity-threshold offset, driest month, and the s / w seasonality
 * margins. Those statistics are computed per climate cell with temperatures reduced to sea level,
 * extended from the land cells across the climate coastline, B-spline interpolated to the pixel and
 * re-lapsed to the pixel's displayed height. Class boundaries therefore follow smooth contours of
 * the underlying fields (not 1° blocks), coasts follow the height map, and mountains get alpine
 * belts. At a climate cell centre with no lapse offset the result equals `classifyKoppen`.
 */
import * as _constants from '../core/constants';
import type { ClimateResult } from '../core/types';
import * as _koppen from '../climate/koppen';
import type { PaintCache } from './paintCache';
import * as _layersSample from './layersSample';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { LAPSE_RATE } = _constants;
const { koppenIdFromCode } = _koppen;
const { EXTEND_RINGS, extendField, splineTables } = _layersSample;

/** Statistics per cell (interleaved). */
export const KS_TMAX = 0;
export const KS_TMIN = 1;
export const KS_MAT = 2;
export const KS_T4 = 3;
export const KS_PSUM = 4;
/** Aridity threshold offset c (pth = 2·MAT + c: 0 winter-, 28 summer-concentrated, else 14). */
export const KS_PTHC = 5;
export const KS_PMIN = 6;
/** > 0 ⟺ dry summer (min(40 − Ps,min, Pw,max/3 − Ps,min)). */
export const KS_SDRY = 7;
/** > 0 ⟺ dry winter (Ps,max/10 − Pw,min). */
export const KS_WDRY = 8;
/** Summer minus winter precipitation (both dry: 'w' if > 0). */
export const KS_SW = 9;
export const KS_N = 10;

const NH_SUMMER = [false, false, false, true, true, true, true, true, true, false, false, false];

/**
 * Köppen statistics of one location from 12 monthly T (°C) and P (mm) (same conventions as
 * classifyKoppen), written to out[o .. o+KS_N).
 */
export function koppenStats(temp: ArrayLike<number>, precip: ArrayLike<number>, southern: boolean, out: Float32Array, o: number): void {
  let tA = 0, tO = 0;
  for (let m = 0; m < 12; m++) {
    const t = Number.isFinite(temp[m]) ? temp[m] : 0;
    if (NH_SUMMER[m]) tA += t;
    else tO += t;
  }
  const southHalf = Math.abs(tA - tO) < 0.6 ? southern : tO > tA;
  let tSum = 0, pSum = 0, tMin = Infinity, tMax = -Infinity, pMin = Infinity, pSummer = 0;
  let sMin = Infinity, sMax = -Infinity, wMin = Infinity, wMax = -Infinity;
  // 4 largest temperatures (descending) for the "≥ 4 months above 10 °C" test.
  let a0 = -Infinity, a1 = -Infinity, a2 = -Infinity, a3 = -Infinity;
  for (let m = 0; m < 12; m++) {
    const t = Number.isFinite(temp[m]) ? temp[m] : 0;
    const p = Number.isFinite(precip[m]) ? Math.max(0, precip[m]) : 0;
    tSum += t;
    pSum += p;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
    if (p < pMin) pMin = p;
    if (t > a3) {
      if (t > a0) { a3 = a2; a2 = a1; a1 = a0; a0 = t; } else if (t > a1) { a3 = a2; a2 = a1; a1 = t; } else if (t > a2) { a3 = a2; a2 = t; } else a3 = t;
    }
    const summer = southHalf ? !NH_SUMMER[m] : NH_SUMMER[m];
    if (summer) {
      pSummer += p;
      if (p < sMin) sMin = p;
      if (p > sMax) sMax = p;
    } else {
      if (p < wMin) wMin = p;
      if (p > wMax) wMax = p;
    }
  }
  const pWinter = pSum - pSummer;
  out[o + KS_TMAX] = tMax;
  out[o + KS_TMIN] = tMin;
  out[o + KS_MAT] = tSum / 12;
  out[o + KS_T4] = a3;
  out[o + KS_PSUM] = pSum;
  out[o + KS_PTHC] = pSum > 0 && pWinter >= 0.7 * pSum ? 0 : pSum > 0 && pSummer >= 0.7 * pSum ? 28 : 14;
  out[o + KS_PMIN] = pMin;
  out[o + KS_SDRY] = Math.min(40 - sMin, wMax / 3 - sMin);
  out[o + KS_WDRY] = sMax / 10 - wMin;
  out[o + KS_SW] = pSummer - pWinter;
}

const id = (code: string): number => {
  const v = koppenIdFromCode(code);
  if (v < 0) throw new Error(`unknown Köppen code ${code}`);
  return v;
};
const ID_ET = id('ET'), ID_EF = id('EF');
const ID_BWH = id('BWh'), ID_BWK = id('BWk'), ID_BSH = id('BSh'), ID_BSK = id('BSk');
const ID_AF = id('Af'), ID_AM = id('Am'), ID_AW = id('Aw');
/** [group C/D][second s/w/f][third a/b/c/d] → id (Cxd does not exist: → Cxc). */
const CD_IDS = (() => {
  const t = new Int32Array(2 * 3 * 4);
  const g = ['C', 'D'], s = ['s', 'w', 'f'], th = ['a', 'b', 'c', 'd'];
  for (let a = 0; a < 2; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 4; c++) {
    const code = `${g[a]}${s[b]}${a === 0 && c === 3 ? 'c' : th[c]}`;
    t[a * 12 + b * 4 + c] = id(code);
  }
  return t;
})();

/**
 * Classify from statistics (stats[o..]) shifted by a uniform temperature offset dT (°C). Equals
 * classifyKoppen(T + dT, P) for the stats of (T, P).
 */
export function classifyStats(st: ArrayLike<number>, o: number, dT: number): number {
  const tMax = st[o + KS_TMAX] + dT;
  if (tMax < 10) return tMax > 0 ? ID_ET : ID_EF;
  const mat = st[o + KS_MAT] + dT;
  const pSum = st[o + KS_PSUM];
  const pth = 2 * mat + st[o + KS_PTHC];
  if (pSum < 10 * pth) {
    const hot = mat >= 18;
    return pSum < 5 * pth ? (hot ? ID_BWH : ID_BWK) : hot ? ID_BSH : ID_BSK;
  }
  const tMin = st[o + KS_TMIN] + dT;
  if (tMin >= 18) {
    const pMin = st[o + KS_PMIN];
    if (pMin >= 60) return ID_AF;
    if (pMin >= 100 - pSum / 25) return ID_AM;
    return ID_AW;
  }
  const d = tMin > 0 ? 0 : 1;
  const sC = st[o + KS_SDRY] > 0, wC = st[o + KS_WDRY] > 0;
  const second = sC && wC ? (st[o + KS_SW] > 0 ? 1 : 0) : sC ? 0 : wC ? 1 : 2;
  const third = tMax >= 22 ? 0 : st[o + KS_T4] + dT > 10 ? 1 : d === 1 && tMin < -38 ? 3 : 2;
  return CD_IDS[d * 12 + second * 4 + third];
}

/**
 * Per climate cell Köppen statistics with temperatures reduced to sea level (T + LAPSE·href),
 * land cells' values diffused EXTEND_RINGS cells out over the sea cells (interleaved, KS_N per
 * cell). Cached per climate id.
 */
export function koppenCellStats(c: ClimateResult, cache: PaintCache): Float32Array {
  return cache.getOrBuild(`kstats|${c.id}`, () => {
    const N = c.w * c.h;
    const raw = new Float32Array(KS_N * N);
    const T = new Float32Array(12), P = new Float32Array(12);
    const sea = c.params.seaLevel;
    for (let i = 0; i < N; i++) {
      const href = c.land[i] ? Math.max(0, c.elev[i] - sea) : 0;
      const up = LAPSE_RATE * href;
      for (let m = 0; m < 12; m++) {
        T[m] = c.temp[m * N + i] + up;
        P[m] = c.precip[m * N + i];
      }
      const row = Math.floor(i / c.w);
      koppenStats(T, P, (row + 0.5) / c.h > 0.5, raw, KS_N * i);
    }
    // Extend each statistic from land cells over the sea (planar fields, then re-interleave).
    const plane = new Float32Array(N), ext = new Float32Array(N), known = new Uint8Array(N);
    const out = new Float32Array(KS_N * N);
    for (let f = 0; f < KS_N; f++) {
      for (let i = 0; i < N; i++) plane[i] = raw[KS_N * i + f];
      extendField(plane, c.w, c.h, c.land, 1, EXTEND_RINGS, ext, known);
      for (let i = 0; i < N; i++) out[KS_N * i + f] = ext[i];
    }
    return out;
  });
}

/** Rolling cache of horizontally B-spline-filtered stat rows (KS_N values per output column). */
class RowFilter {
  private readonly slots: Float32Array[] = [];
  private readonly rowOf: Int32Array;
  private next = 0;
  constructor(
    private readonly st: Float32Array, private readonly cw: number, private readonly w: number,
    private readonly ci: Int32Array, private readonly cwt: Float32Array,
  ) {
    for (let s = 0; s < 6; s++) this.slots.push(new Float32Array(KS_N * w));
    this.rowOf = new Int32Array(6).fill(-1);
  }

  row(j: number): Float32Array {
    for (let s = 0; s < 6; s++) if (this.rowOf[s] === j) return this.slots[s];
    const s = this.next;
    this.next = (this.next + 1) % 6;
    this.rowOf[s] = j;
    const buf = this.slots[s];
    const { st, cw, w, ci, cwt } = this;
    const base = j * cw;
    for (let c = 0, k = 0; c < w; c++, k += 4) {
      const o0 = KS_N * (base + ci[k]), o1 = KS_N * (base + ci[k + 1]), o2 = KS_N * (base + ci[k + 2]), o3 = KS_N * (base + ci[k + 3]);
      const w0 = cwt[k], w1 = cwt[k + 1], w2 = cwt[k + 2], w3 = cwt[k + 3];
      const o = KS_N * c;
      for (let f = 0; f < KS_N; f++) buf[o + f] = w0 * st[o0 + f] + w1 * st[o1 + f] + w2 * st[o2 + f] + w3 * st[o3 + f];
    }
    return buf;
  }
}

/**
 * Köppen class per pixel where the quantized coast distance qd[p] > qMin (else 0), at the displayed
 * height above sea hp(p) = max(0, height − sea).
 */
export function classifyPixels(
  c: ClimateResult, height: Float32Array, sea: number, w: number, h: number, qd: Int8Array, qMin: number, cache: PaintCache,
): Uint8Array {
  const st = koppenCellStats(c, cache);
  const { ci, cwt, ri, rwt } = splineTables(w, h, c.w, c.h, cache);
  const rf = new RowFilter(st, c.w, w, ci, cwt);
  const out = new Uint8Array(w * h);
  const v = new Float32Array(KS_N);
  for (let r = 0, k = 0; r < h; r++, k += 4) {
    let A: Float32Array | null = null, B: Float32Array | null = null, C: Float32Array | null = null, D: Float32Array | null = null;
    const wa = rwt[k], wb = rwt[k + 1], wc = rwt[k + 2], wd = rwt[k + 3];
    const row = r * w;
    for (let col = 0; col < w; col++) {
      const p = row + col;
      if (qd[p] <= qMin) continue;
      if (!A) {
        A = rf.row(ri[k]); B = rf.row(ri[k + 1]); C = rf.row(ri[k + 2]); D = rf.row(ri[k + 3]);
      }
      const o = KS_N * col;
      for (let f = 0; f < KS_N; f++) v[f] = wa * A[o + f] + wb * B![o + f] + wc * C![o + f] + wd * D![o + f];
      const e = height[p] - sea;
      out[p] = classifyStats(v, 0, e > 0 ? -LAPSE_RATE * e : 0);
    }
  }
  return out;
}
