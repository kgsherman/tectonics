/**
 * Per-climate-cell surface attributes for the satellite layer (SPEC §7): Köppen class endmembers
 * (humid soil, tree cap, evergreen / sclerophyll share) modulated by continuous climate fields
 * (aridity ratio, warm/cold-month temperature, monthly phenology). Attributes, never class ids,
 * are what gets interpolated. Output grids are dilated from land over coastal ocean cells,
 * blurred ~1 cell and padded for the warped bilinear sampler.
 *
 * Temperatures are stored SEA-LEVEL-REDUCED (T + Γ·h_ref) so each pixel re-applies the lapse rate
 * to its own amplified height (alpine belts, treeline, snow line).
 */
import { LAPSE_RATE } from '../core/constants';
import { gridLat } from '../core/grid';
import type { ClimateResult, RGB } from '../core/types';
import { KOPPEN_CLASSES, koppenIdFromCode } from '../climate/koppen';
import { toLinear } from './colormaps';
import { padGrid } from './satelliteSampler';

// Land attribute channels (interleaved per cell).
export const A_SOIL = 0; // 3: humid-soil colour (linear RGB)
export const A_GRASS = 3; // 3: herbaceous layer colour this month (linear RGB)
export const A_TREE = 6; // 3: canopy colour this month (linear RGB)
export const A_COVER = 9; // moisture-limited total vegetation cover 0..1
export const A_TREES = 10; // moisture/structure-limited tree cover 0..1
export const A_TWARM = 11; // sea-level-reduced warmest-month temperature (°C)
export const A_TSNOW = 12; // sea-level-reduced snow-season temperature this month (°C)
export const A_SNOWSUP = 13; // snow supply (recent precipitation) 0..1
export const A_DESERT = 14; // desert (bare sand/rock) weight 0..1
export const A_HOT = 15; // hot (vs cold) desert 0..1
export const A_WET = 16; // humidity 0..1 (rock tint, lushness)
export const A_PANN = 17; // annual precipitation, m/yr (glacier nourishment)
export const LAND_K = 18;
// Ocean attribute channels.
export const O_ICE = 0;
export const O_SST = 1;
export const OCEAN_K = 2;

export interface SatelliteGrid {
  cw: number;
  ch: number;
  /** Padded (cw+1)×(ch+1)×LAND_K. */
  land: Float32Array;
  /** Padded (cw+1)×(ch+1)×OCEAN_K. */
  ocean: Float32Array;
}

/** Continuous per-cell climate statistics (month independent). */
interface CellStats {
  tWarm: number;
  tCold: number;
  mat: number;
  pAnn: number;
  /** Köppen aridity ratio P_ann / P_threshold (1 = B/non-B boundary, 0.5 = BW/BS). */
  aridity: number;
}

interface ClassEndmember {
  treeCap: number;
  evergreen: number;
  sclero: number;
  soil: RGB;
}

const EM: Record<string, ClassEndmember> = {
  Af: { treeCap: 1, evergreen: 1, sclero: 0, soil: [146, 88, 58] },
  Am: { treeCap: 0.95, evergreen: 0.85, sclero: 0, soil: [150, 92, 60] },
  Aw: { treeCap: 0.42, evergreen: 0.3, sclero: 0.15, soil: [162, 108, 70] },
  BWh: { treeCap: 0.08, evergreen: 0.4, sclero: 0.6, soil: [196, 156, 108] },
  BWk: { treeCap: 0.08, evergreen: 0.5, sclero: 0.3, soil: [164, 148, 126] },
  BSh: { treeCap: 0.25, evergreen: 0.35, sclero: 0.6, soil: [172, 128, 86] },
  BSk: { treeCap: 0.3, evergreen: 0.5, sclero: 0.3, soil: [150, 132, 104] },
  Csa: { treeCap: 0.55, evergreen: 0.85, sclero: 1, soil: [160, 120, 84] },
  Csb: { treeCap: 0.7, evergreen: 0.8, sclero: 0.7, soil: [142, 112, 82] },
  Csc: { treeCap: 0.8, evergreen: 0.8, sclero: 0.2, soil: [122, 106, 86] },
  Cwa: { treeCap: 0.8, evergreen: 0.5, sclero: 0.1, soil: [152, 102, 70] },
  Cwb: { treeCap: 0.8, evergreen: 0.6, sclero: 0.2, soil: [142, 106, 78] },
  Cwc: { treeCap: 0.8, evergreen: 0.7, sclero: 0.1, soil: [122, 102, 82] },
  Cfa: { treeCap: 0.9, evergreen: 0.45, sclero: 0.1, soil: [140, 100, 70] },
  Cfb: { treeCap: 0.9, evergreen: 0.35, sclero: 0, soil: [114, 96, 74] },
  Cfc: { treeCap: 0.85, evergreen: 0.7, sclero: 0, soil: [106, 96, 82] },
  Dsa: { treeCap: 0.55, evergreen: 0.7, sclero: 0.4, soil: [140, 118, 90] },
  Dsb: { treeCap: 0.65, evergreen: 0.75, sclero: 0.2, soil: [132, 114, 90] },
  Dsc: { treeCap: 0.75, evergreen: 0.85, sclero: 0, soil: [120, 108, 90] },
  Dsd: { treeCap: 0.75, evergreen: 0.6, sclero: 0, soil: [118, 106, 90] },
  Dwa: { treeCap: 0.85, evergreen: 0.35, sclero: 0, soil: [128, 106, 80] },
  Dwb: { treeCap: 0.9, evergreen: 0.5, sclero: 0, soil: [120, 102, 80] },
  Dwc: { treeCap: 0.9, evergreen: 0.65, sclero: 0, soil: [112, 100, 84] },
  Dwd: { treeCap: 0.85, evergreen: 0.25, sclero: 0, soil: [110, 100, 86] },
  Dfa: { treeCap: 0.9, evergreen: 0.3, sclero: 0, soil: [126, 104, 78] },
  Dfb: { treeCap: 0.95, evergreen: 0.55, sclero: 0, soil: [116, 100, 80] },
  Dfc: { treeCap: 0.95, evergreen: 0.85, sclero: 0, soil: [106, 98, 84] },
  // Dfd: Siberian larch taiga — deciduous needleleaf.
  Dfd: { treeCap: 0.9, evergreen: 0.25, sclero: 0, soil: [106, 98, 86] },
  // Polar classes: temperature (applied per pixel) removes trees; structure like the boreal zone.
  ET: { treeCap: 0.85, evergreen: 0.8, sclero: 0, soil: [112, 104, 92] },
  EF: { treeCap: 0.85, evergreen: 0.8, sclero: 0, soil: [122, 116, 108] },
};

const ENDMEMBERS: Array<ClassEndmember & { soilLin: [number, number, number] }> = KOPPEN_CLASSES.map((k) => {
  const e = EM[k.code] ?? EM.Cfb;
  return { ...e, soilLin: toLinear(e.soil) };
});

const FALLBACK_CLASS = koppenIdFromCode('Cfb');

const L = (c: RGB) => toLinear(c);
/** Vegetation palette (sRGB tuned against Blue Marble / Sentinel-2 mosaics), linear light. */
export const PAL = {
  grassLush: L([74, 110, 42]),
  grassSteppe: L([124, 132, 70]),
  grassDryWarm: L([178, 158, 108]),
  grassDormantCold: L([128, 114, 90]),
  leafOn: L([50, 82, 36]),
  leafOff: L([94, 86, 74]),
  tropical: L([30, 60, 26]),
  boreal: L([26, 44, 32]),
  sclerophyll: L([72, 82, 50]),
};

function smoothstep(a: number, b: number, x: number): number {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Potential evapotranspiration proxy, mm/month (moisture index denominator). */
function pet(t: number): number {
  return t > 0 ? 12 + 4.6 * t : 12;
}

function cellStats(T: Float64Array, P: Float64Array, south: boolean): CellStats {
  let tWarm = -Infinity, tCold = Infinity, tSum = 0, pAnn = 0, tA = 0, tO = 0, pA = 0;
  for (let m = 0; m < 12; m++) {
    const t = T[m], p = P[m];
    if (t > tWarm) tWarm = t;
    if (t < tCold) tCold = t;
    tSum += t;
    pAnn += p;
    if (m >= 3 && m <= 8) { tA += t; pA += p; } else tO += t;
  }
  const mat = tSum / 12;
  // Summer half = the warmer of AMJJAS / ONDJFM (as in the classifier).
  const nhSummer = Math.abs(tA - tO) < 0.6 ? !south : tA > tO;
  const pSummer = nhSummer ? pA : pAnn - pA;
  const sFrac = pAnn > 0 ? pSummer / pAnn : 0.5;
  // Continuous version of the Köppen threshold offset (0 winter rain, 14 even, 28 summer rain).
  const off = 14 + 14 * Math.max(-1, Math.min(1, (sFrac - 0.5) / 0.2));
  const pth = 10 * (2 * mat + off); // mm/yr
  // Soft floor so cold climates (pth ≤ 0) read as humid rather than dividing by ~0.
  const pthSoft = pth > 60 ? pth : 60 * Math.exp((pth - 60) / 60);
  return { tWarm, tCold, mat, pAnn, aridity: pAnn / pthSoft };
}

/** Month greenness of the herbaceous layer: warm enough and moist enough (0..1). */
function greenness(T: Float64Array, P: Float64Array, k: number): number {
  const pEff = 0.65 * P[k] + 0.35 * P[(k + 11) % 12];
  return smoothstep(1, 10, T[k]) * smoothstep(0.2, 0.75, pEff / pet(T[k]));
}

/** Deciduous leaf-on fraction: thermal (temperate) and drought (tropical) deciduousness. */
function leafOn(T: Float64Array, P: Float64Array, k: number): number {
  const moist = (0.6 * P[k] + 0.4 * P[(k + 11) % 12]) / pet(T[k]);
  return Math.min(smoothstep(2, 9, T[k]), smoothstep(0.12, 0.45, moist));
}

// Scratch colours for cellAttributes (no per-cell allocation).
const DOR = new Float64Array(3), GRN = new Float64Array(3), EVER = new Float64Array(3), DEC = new Float64Array(3);

function mixInto(out: Float32Array, o: number, a: ArrayLike<number>, b: ArrayLike<number>, t: number): void {
  out[o] = a[0] + (b[0] - a[0]) * t;
  out[o + 1] = a[1] + (b[1] - a[1]) * t;
  out[o + 2] = a[2] + (b[2] - a[2]) * t;
}

/**
 * Attributes of one cell for month m (0..11) or the annual representative (m = -1: greenness
 * 0.5·(mean + max) over the cell's own months, permanent snow only).
 */
function cellAttributes(
  T: Float64Array, P: Float64Array, st: CellStats, em: (typeof ENDMEMBERS)[number], hRef: number, m: number,
  out: Float32Array, o: number,
): void {
  const a = st.aridity;
  const wet = a / (1 + a);
  // Moisture-limited cover: ~0.1 at a = 0.2 (hyper-arid), ~0.35 at 0.5 (BW/BS), ~0.75 at 1.
  const cover = 1 - Math.exp(-1.3 * Math.pow(Math.max(0, a), 1.6));
  const trees = Math.min(em.treeCap, smoothstep(0.75, 1.9, a)) * cover;
  const desert = 1 - smoothstep(0.18, 0.75, a);
  const hot = smoothstep(4, 16, st.mat);
  // Soil: humid soils per class, drifting to dry-steppe browns as aridity grows.
  const steppe = smoothstep(1.4, 0.5, a) * (1 - desert);
  out[o + A_SOIL] = em.soilLin[0] * (1 - 0.3 * steppe) + 0.3 * steppe * 0.33;
  out[o + A_SOIL + 1] = em.soilLin[1] * (1 - 0.3 * steppe) + 0.3 * steppe * 0.24;
  out[o + A_SOIL + 2] = em.soilLin[2] * (1 - 0.3 * steppe) + 0.3 * steppe * 0.14;

  let g: number, lo: number, tMonth: number;
  if (m >= 0) {
    g = greenness(T, P, m);
    lo = leafOn(T, P, m);
    tMonth = T[m];
  } else {
    let gs = 0, gm = 0, ls = 0, lm = 0;
    for (let k = 0; k < 12; k++) {
      const gk = greenness(T, P, k), lk = leafOn(T, P, k);
      gs += gk;
      ls += lk;
      if (gk > gm) gm = gk;
      if (lk > lm) lm = lk;
    }
    g = 0.5 * (gs / 12 + gm);
    lo = 0.5 * (ls / 12 + lm);
    tMonth = st.tWarm;
  }
  // Herbaceous layer: green ↔ dormant (golden when warm-dry, brown when cold).
  const cold = smoothstep(8, -4, tMonth);
  const lush = smoothstep(0.35, 0.8, wet);
  for (let q = 0; q < 3; q++) {
    DOR[q] = PAL.grassDryWarm[q] + (PAL.grassDormantCold[q] - PAL.grassDryWarm[q]) * cold;
    GRN[q] = PAL.grassSteppe[q] + (PAL.grassLush[q] - PAL.grassSteppe[q]) * lush;
  }
  mixInto(out, o + A_GRASS, DOR, GRN, g);
  // Canopy: evergreen (tropical broadleaf ↔ boreal needleleaf, sclerophyll tint) vs deciduous.
  const needle = smoothstep(6, -12, st.tCold);
  for (let q = 0; q < 3; q++) {
    const bl = PAL.tropical[q] + (PAL.boreal[q] - PAL.tropical[q]) * needle;
    EVER[q] = bl + (PAL.sclerophyll[q] - bl) * em.sclero * (1 - needle);
    DEC[q] = PAL.leafOff[q] + (PAL.leafOn[q] - PAL.leafOff[q]) * lo;
  }
  // Tropical wet climates are evergreen whatever the class blend says.
  const everFrac = Math.max(em.evergreen, smoothstep(14, 20, st.tCold) * smoothstep(1.3, 2.2, a));
  mixInto(out, o + A_TREE, DEC, EVER, everFrac);
  out[o + A_COVER] = cover;
  out[o + A_TREES] = trees;
  const lapse = LAPSE_RATE * hRef;
  out[o + A_TWARM] = st.tWarm + lapse;
  if (m >= 0) {
    const km = (m + 11) % 12;
    // Snowpack lags the air temperature. Supply = precipitation accumulated over the cold season
    // leading up to this month (months colder than +4 °C at the cell, a margin for colder pixels).
    out[o + A_TSNOW] = 0.6 * T[m] + 0.4 * T[km] + lapse;
    let acc = P[m];
    for (let k = 1; k < 7; k++) {
      const mk = (m + 12 - k) % 12;
      if (T[mk] >= 4) break;
      acc += P[mk];
    }
    out[o + A_SNOWSUP] = Math.min(1, acc / 30);
  } else {
    // Annual: only permanent snowfields (summer below ~+3 °C at the pixel).
    out[o + A_TSNOW] = st.tWarm - 4 + lapse;
    out[o + A_SNOWSUP] = Math.min(1, st.pAnn / 250);
  }
  out[o + A_DESERT] = desert;
  out[o + A_HOT] = hot;
  out[o + A_WET] = wet;
  out[o + A_PANN] = st.pAnn / 1000;
}

/** Nearest-land dilation: ocean cells within `rings` 8-neighbour rings of land take the mean of their assigned neighbours. */
function dilateLand(grid: Float32Array, isLand: Uint8Array, cw: number, ch: number, k: number, rings: number): void {
  const assigned = isLand.slice();
  const next = new Uint8Array(cw * ch);
  const acc = new Float64Array(k);
  for (let ring = 0; ring < rings; ring++) {
    next.set(assigned);
    for (let r = 0; r < ch; r++) {
      for (let c = 0; c < cw; c++) {
        const i = r * cw + c;
        if (assigned[i]) continue;
        let cnt = 0;
        acc.fill(0);
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= ch) continue;
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const j = rr * cw + ((c + dc + cw) % cw);
            if (!assigned[j]) continue;
            cnt++;
            for (let q = 0; q < k; q++) acc[q] += grid[j * k + q];
          }
        }
        if (cnt > 0) {
          for (let q = 0; q < k; q++) grid[i * k + q] = acc[q] / cnt;
          next[i] = 1;
        }
      }
    }
    assigned.set(next);
  }
}

/** Separable [1 2 1]/4 blur of an interleaved grid (lon wraps, rows clamp), `passes` times. */
export function blurGrid(grid: Float32Array, cw: number, ch: number, k: number, passes: number): void {
  const tmp = new Float32Array(grid.length);
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < ch; r++) {
      for (let c = 0; c < cw; c++) {
        const i = (r * cw + c) * k;
        const il = (r * cw + (c > 0 ? c - 1 : cw - 1)) * k;
        const ir = (r * cw + (c < cw - 1 ? c + 1 : 0)) * k;
        for (let q = 0; q < k; q++) tmp[i + q] = 0.25 * grid[il + q] + 0.5 * grid[i + q] + 0.25 * grid[ir + q];
      }
    }
    for (let r = 0; r < ch; r++) {
      const ru = r > 0 ? r - 1 : 0, rd = r < ch - 1 ? r + 1 : ch - 1;
      for (let c = 0; c < cw; c++) {
        const i = (r * cw + c) * k, iu = (ru * cw + c) * k, id = (rd * cw + c) * k;
        for (let q = 0; q < k; q++) grid[i + q] = 0.25 * tmp[iu + q] + 0.5 * tmp[i + q] + 0.25 * tmp[id + q];
      }
    }
  }
}

/** The climate fields the satellite attributes need (a ClimateResult, or a synthetic stand-in). */
export type SatelliteClimate = Pick<ClimateResult, 'w' | 'h' | 'land' | 'elev' | 'temp' | 'precip' | 'seaIce' | 'sst' | 'koppenAll'> & {
  seaLevel: number;
};

export function satelliteClimateOf(c: ClimateResult): SatelliteClimate {
  return {
    w: c.w, h: c.h, land: c.land, elev: c.elev, temp: c.temp, precip: c.precip, seaIce: c.seaIce, sst: c.sst,
    koppenAll: c.koppenAll, seaLevel: c.params.seaLevel,
  };
}

/** Satellite attribute grids for one month (0..11) or the annual representative (-1). */
export function buildSatelliteGrid(climate: SatelliteClimate, month: number): SatelliteGrid {
  const { w: cw, h: ch } = climate;
  const N = cw * ch;
  const sea = climate.seaLevel;
  const land = new Float32Array(N * LAND_K);
  const ocean = new Float32Array(N * OCEAN_K);
  const T = new Float64Array(12), P = new Float64Array(12);
  const isLand = new Uint8Array(N);
  for (let r = 0; r < ch; r++) {
    const south = gridLat(ch, r) < 0;
    for (let c = 0; c < cw; c++) {
      const i = r * cw + c;
      for (let m = 0; m < 12; m++) {
        T[m] = climate.temp[m * N + i];
        P[m] = Math.max(0, climate.precip[m * N + i]);
      }
      isLand[i] = climate.land[i];
      const st = cellStats(T, P, south);
      const hRef = climate.land[i] ? Math.max(0, climate.elev[i] - sea) : 0;
      const kid = climate.koppenAll[i];
      const em = ENDMEMBERS[kid > 0 && kid < ENDMEMBERS.length ? kid : FALLBACK_CLASS];
      cellAttributes(T, P, st, em, hRef, month, land, i * LAND_K);
      if (month >= 0) {
        ocean[i * OCEAN_K + O_ICE] = climate.seaIce[month * N + i];
        ocean[i * OCEAN_K + O_SST] = climate.sst[month * N + i];
      } else {
        let iceMin = Infinity, sstSum = 0;
        for (let m = 0; m < 12; m++) {
          iceMin = Math.min(iceMin, climate.seaIce[m * N + i]);
          sstSum += climate.sst[m * N + i];
        }
        ocean[i * OCEAN_K + O_ICE] = iceMin;
        ocean[i * OCEAN_K + O_SST] = sstSum / 12;
      }
    }
  }
  dilateLand(land, isLand, cw, ch, LAND_K, 3);
  blurGrid(land, cw, ch, LAND_K, 2);
  blurGrid(ocean, cw, ch, OCEAN_K, 1);
  return { cw, ch, land: padGrid(land, cw, ch, LAND_K), ocean: padGrid(ocean, cw, ch, OCEAN_K) };
}
