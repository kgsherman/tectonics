import type { KoppenClassInfo, KoppenGroup, RGB } from '../core/types';

const DEF: Array<[string, string, KoppenGroup, RGB]> = [
  ['Ocean', 'Ocean', 'ocean', [36, 58, 92]],
  ['Af', 'Tropical rainforest', 'A', [0, 0, 255]],
  ['Am', 'Tropical monsoon', 'A', [0, 120, 255]],
  ['Aw', 'Tropical savanna', 'A', [70, 170, 250]],
  ['BWh', 'Hot desert', 'B', [255, 0, 0]],
  ['BWk', 'Cold desert', 'B', [255, 150, 150]],
  ['BSh', 'Hot semi-arid', 'B', [245, 165, 0]],
  ['BSk', 'Cold semi-arid', 'B', [255, 220, 100]],
  ['Csa', 'Hot-summer Mediterranean', 'C', [255, 255, 0]],
  ['Csb', 'Warm-summer Mediterranean', 'C', [200, 200, 0]],
  ['Csc', 'Cold-summer Mediterranean', 'C', [150, 150, 0]],
  ['Cwa', 'Monsoon humid subtropical', 'C', [150, 255, 150]],
  ['Cwb', 'Subtropical highland', 'C', [100, 200, 100]],
  ['Cwc', 'Cold subtropical highland', 'C', [50, 150, 50]],
  ['Cfa', 'Humid subtropical', 'C', [200, 255, 80]],
  ['Cfb', 'Oceanic', 'C', [100, 255, 80]],
  ['Cfc', 'Subpolar oceanic', 'C', [50, 200, 0]],
  ['Dsa', 'Hot-summer Mediterranean continental', 'D', [255, 0, 255]],
  ['Dsb', 'Warm-summer Mediterranean continental', 'D', [200, 0, 200]],
  ['Dsc', 'Dry-summer subarctic', 'D', [150, 50, 150]],
  ['Dsd', 'Dry-summer extremely cold subarctic', 'D', [150, 100, 150]],
  ['Dwa', 'Monsoon hot-summer continental', 'D', [170, 175, 255]],
  ['Dwb', 'Monsoon warm-summer continental', 'D', [90, 120, 220]],
  ['Dwc', 'Monsoon subarctic', 'D', [75, 80, 180]],
  ['Dwd', 'Monsoon extremely cold subarctic', 'D', [50, 0, 135]],
  ['Dfa', 'Hot-summer humid continental', 'D', [0, 255, 255]],
  ['Dfb', 'Warm-summer humid continental', 'D', [55, 200, 255]],
  ['Dfc', 'Subarctic', 'D', [0, 125, 125]],
  ['Dfd', 'Extremely cold subarctic', 'D', [0, 70, 95]],
  ['ET', 'Tundra', 'E', [178, 178, 178]],
  ['EF', 'Ice cap', 'E', [102, 102, 102]],
];

/**
 * Index = class id. 0 = Ocean, then the 30 classes of Beck et al. (2018) in this order:
 * Af Am Aw BWh BWk BSh BSk Csa Csb Csc Cwa Cwb Cwc Cfa Cfb Cfc
 * Dsa Dsb Dsc Dsd Dwa Dwb Dwc Dwd Dfa Dfb Dfc Dfd ET EF
 */
export const KOPPEN_CLASSES: KoppenClassInfo[] = DEF.map(([code, name, group, color], id) => ({ id, code, name, group, color }));

const BY_CODE = new Map<string, number>(KOPPEN_CLASSES.map((c) => [c.code, c.id]));

export interface KoppenOptions {
  /** Temperature separating C from D: 0 (default, Beck/Peel) or -3 (original Köppen). */
  cdBoundary?: 0 | -3;
}

/** Lookup by code (e.g. 'Cfb'); -1 if unknown. */
export function koppenIdFromCode(code: string): number {
  return BY_CODE.get(code) ?? -1;
}

const NH_SUMMER = [false, false, false, true, true, true, true, true, true, false, false, false];

/**
 * Classify a land location from 12 monthly mean temperatures (°C) and precipitation totals (mm),
 * January..December, following Peel et al. (2007) / Beck et al. (2018). `southern` = location is in
 * the southern hemisphere (summer = Oct..Mar). Returns a class id (1..30). Never returns 0.
 */
export function classifyKoppen(temp: ArrayLike<number>, precip: ArrayLike<number>, southern: boolean, opts?: KoppenOptions): number {
  const cd = opts?.cdBoundary ?? 0;
  // Summer = the warmer of AMJJAS / ONDJFM (Peel et al. 2007); hemisphere flag only breaks near-ties.
  let tAMJJAS = 0, tONDJFM = 0;
  for (let m = 0; m < 12; m++) {
    const t = Number.isFinite(temp[m]) ? temp[m] : 0;
    if (NH_SUMMER[m]) tAMJJAS += t;
    else tONDJFM += t;
  }
  const southHalf = Math.abs(tAMJJAS - tONDJFM) < 0.6 ? southern : tONDJFM > tAMJJAS;
  let tSum = 0, pSum = 0, tMin = Infinity, tMax = -Infinity, pMin = Infinity, warm10 = 0;
  let pSummer = 0, sMin = Infinity, sMax = -Infinity, wMin = Infinity, wMax = -Infinity;
  for (let m = 0; m < 12; m++) {
    const t = Number.isFinite(temp[m]) ? temp[m] : 0;
    const p = Number.isFinite(precip[m]) ? Math.max(0, precip[m]) : 0;
    tSum += t;
    pSum += p;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
    if (p < pMin) pMin = p;
    if (t > 10) warm10++;
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
  const mat = tSum / 12;
  const pWinter = pSum - pSummer;

  // E: polar
  if (tMax < 10) return tMax > 0 ? id('ET') : id('EF');

  // B: arid
  let pth: number;
  if (pSum > 0 && pWinter >= 0.7 * pSum) pth = 2 * mat;
  else if (pSum > 0 && pSummer >= 0.7 * pSum) pth = 2 * mat + 28;
  else pth = 2 * mat + 14;
  if (pSum < 10 * pth) {
    const w = pSum < 5 * pth;
    const h = mat >= 18;
    return id(w ? (h ? 'BWh' : 'BWk') : h ? 'BSh' : 'BSk');
  }

  // A: tropical
  if (tMin >= 18) {
    if (pMin >= 60) return id('Af');
    if (pMin >= 100 - pSum / 25) return id('Am');
    return id('Aw');
  }

  // C / D: temperate / continental
  const group = tMin > cd ? 'C' : 'D';
  const sCond = sMin < 40 && sMin < wMax / 3;
  const wCond = wMin < sMax / 10;
  let second: 's' | 'w' | 'f';
  if (sCond && wCond) second = pSummer > pWinter ? 'w' : 's';
  else if (sCond) second = 's';
  else if (wCond) second = 'w';
  else second = 'f';
  let third: 'a' | 'b' | 'c' | 'd';
  if (tMax >= 22) third = 'a';
  else if (warm10 >= 4) third = 'b';
  else if (group === 'D' && tMin < -38) third = 'd';
  else third = 'c';
  return id(`${group}${second}${third}`);
}

function id(code: string): number {
  const v = BY_CODE.get(code);
  if (v === undefined) throw new Error(`unknown Köppen code ${code}`);
  return v;
}
