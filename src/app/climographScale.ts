/**
 * Axis scaling for the hover climograph: monthly temperature line over precipitation bars.
 * Temperature spans whole multiples of 10 °C and always includes 0 °C with ≥ 30 °C of range, so
 * climates are visually comparable; precipitation starts at 0 with a "nice" maximum ≥ 50 mm.
 */
export interface ClimographScale {
  tMin: number;
  tMax: number;
  tTicks: number[];
  pMax: number;
  pTicks: number[];
  /** Vertical position 0 (bottom) .. 1 (top). */
  tFrac(t: number): number;
  pFrac(p: number): number;
}

const NICE_P = [50, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000];
const P_STEPS = [10, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];

function finiteExtent(a: ArrayLike<number>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Smallest "nice" precipitation maximum ≥ v (mm). */
export function nicePrecipMax(v: number): number {
  for (const p of NICE_P) if (v <= p) return p;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / mag) * mag;
}

/** Tick step giving at most 5 intervals that divide pMax evenly. */
function precipStep(pMax: number): number {
  for (const s of P_STEPS) if (pMax / s <= 5 && pMax % s === 0) return s;
  return pMax / 5;
}

function ticks(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export function climographScale(temp: ArrayLike<number>, precip: ArrayLike<number>): ClimographScale {
  const te = finiteExtent(temp) ?? [0, 0];
  const tMin = Math.min(0, Math.floor(te[0] / 10) * 10);
  const tMax = Math.max(tMin + 30, Math.ceil(te[1] / 10) * 10);
  const pe = finiteExtent(precip);
  const pMax = nicePrecipMax(Math.max(50, pe ? pe[1] : 0));
  const tSpan = tMax - tMin;
  return {
    tMin,
    tMax,
    tTicks: ticks(tMin, tMax, tSpan > 80 ? 20 : 10),
    pMax,
    pTicks: ticks(0, pMax, precipStep(pMax)),
    tFrac: (t) => (Number.isFinite(t) ? (t - tMin) / tSpan : 0),
    pFrac: (p) => (Number.isFinite(p) ? Math.max(0, Math.min(1, p / pMax)) : 0),
  };
}
