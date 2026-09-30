/**
 * Monthly snowpack (SPEC §6.2): precipitation accumulates as snow when the monthly mean
 * temperature is below ~0 °C (linear rain/snow ramp), melts by positive degree-days (expected
 * PDD of a normal daily-temperature distribution around the monthly mean, Calov & Greve 2005),
 * and snow cover follows from the month-mean snow water equivalent. Spun up over a few annual
 * cycles so January sees the pack left by December. Over ocean cells snow lies only on sea ice.
 */
import { DAYS_PER_MONTH } from '../core/constants';
import type { HydroTuning } from './hydroTuning';

/** Complementary error function (Abramowitz & Stegun 7.1.26, |ε| < 1.5e-7). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
  return x >= 0 ? y : 2 - y;
}

/** Expected positive degree-days per day for daily T ~ N(meanC, sigma²). */
export function positiveDegreeDaysPerDay(meanC: number, sigma: number): number {
  if (!(sigma > 0)) return meanC > 0 ? meanC : 0;
  return (sigma / Math.sqrt(2 * Math.PI)) * Math.exp((-meanC * meanC) / (2 * sigma * sigma)) + 0.5 * meanC * erfc(-meanC / (Math.SQRT2 * sigma));
}

export interface SnowInputs {
  n: number;
  /** 12*n monthly air temperature (°C) and precipitation (mm/month). */
  temp: Float32Array;
  precip: Float32Array;
  /** n: 1 = land cell. */
  land: Uint8Array;
  /** 12*n sea-ice fraction. */
  seaIce: Float32Array;
}

/** Snow-cover fraction 0..1 (12*n) from a spun-up monthly snowpack. */
export function computeSnowCover(inp: SnowInputs, t: HydroTuning, out: Float32Array): void {
  const { n, temp, precip, land, seaIce } = inp;
  const ramp = t.snowTempHigh - t.snowTempLow;
  const meltPerDegreeMonth = t.degreeDayFactor * DAYS_PER_MONTH;
  const years = Math.max(1, Math.round(t.snowSpinupYears));
  for (let i = 0; i < n; i++) {
    let swe = 0;
    for (let y = 0; y < years; y++) {
      const last = y === years - 1;
      for (let m = 0; m < 12; m++) {
        const k = m * n + i;
        const T = temp[k];
        const snowFrac = ramp > 0 ? Math.min(1, Math.max(0, (t.snowTempHigh - T) / ramp)) : T < t.snowTempLow ? 1 : 0;
        const snowfall = snowFrac * Math.max(0, precip[k]);
        const meltCapacity = meltPerDegreeMonth * positiveDegreeDaysPerDay(T, t.degreeDaySigma);
        const available = swe + snowfall;
        const melt = meltCapacity < available ? meltCapacity : available;
        let end = available - melt;
        if (end > t.sweMax) end = t.sweMax;
        if (last) {
          // Month-mean SWE plus transient snow that falls and melts within the month.
          const transient = 0.25 * Math.min(snowfall, melt);
          const mean = 0.5 * (swe + end) + transient;
          let cover = 1 - Math.exp(-mean / t.snowCoverScale);
          if (!land[i]) {
            const ice = seaIce[k];
            cover *= ice > 1 ? 1 : ice > 0 ? ice : 0;
          }
          out[k] = cover;
        }
        swe = end;
      }
    }
  }
}
