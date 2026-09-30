/**
 * Surface-based inversions over snow-covered land in the low-sun season (Siberian and Canadian
 * winters, the ice-sheet plateaus). The energy balance carries one temperature per column, the
 * boundary-layer air mass that exchanges heat with its surroundings and radiates to space. Under
 * weak insolation a snow surface radiates freely and the air next to it becomes much colder than the
 * air mass above it (10–25 K on the Antarctic plateau and in Yakutian winters), so the reported
 * near-surface temperature of snow-covered land is lowered by
 *
 *   ΔT = inversionMax · snow · clamp(1 − Q/inversionInsolation, 0, 1)^inversionPower · clear
 *
 * with Q the month's daily-mean top-of-atmosphere insolation and, when the month's cloud cover is
 * given, clear = clamp((inversionCloudOvercast − cloud)/(inversionCloudOvercast − inversionCloudClear))
 * (the inversion is a clear-sky phenomenon: cloudy, windy maritime winters stay mixed). Diagnostic:
 * it does not feed back on the energy budget (the air mass above keeps its temperature and OLR)
 * nor on the moisture solver.
 */
import { SOLAR_CONSTANT } from '../core/constants';
import type { ClimateParams } from '../core/types';
import { dailyInsolation, declinationAt } from './insolation';
import { ebmTuning } from './tuning';

/** Lower `temp` (12·w·h, °C) in place over land (`land` w·h) by the snow-surface inversion. */
export function applySurfaceInversion(
  temp: Float32Array,
  snow: Float32Array,
  land: Uint8Array,
  w: number,
  h: number,
  params: ClimateParams,
  height?: ArrayLike<number>,
  cloud?: ArrayLike<number>,
  landIce?: ArrayLike<number>,
): void {
  const t = ebmTuning;
  if (!(t.inversionMax > 0)) return;
  const N = w * h;
  const cloudSpan = t.inversionCloudOvercast - t.inversionCloudClear;
  const useCloud = !!cloud && cloudSpan > 0;
  // Katabatic drainage on sloping terrain (ice-sheet margins, mountain flanks) keeps the surface
  // layer mixed: the inversion weakens as exp(−slope/inversionSlope), slope in m per km.
  const slopeFactor = new Float32Array(N).fill(1);
  // Ice sheets: the extra inversion of the flat, permanently snow-covered interior (katabatic
  // drainage mixes the sloping margins); weight = ice cover × exp(−(slope/inversionIceSheetSlope)²).
  const sheetFactor = landIce && t.inversionIceSheetExtra > 0 ? new Float32Array(N) : null;
  if (sheetFactor) for (let i = 0; i < N; i++) sheetFactor[i] = landIce![i];
  if (height && (t.inversionSlope > 0 || sheetFactor)) {
    const R = 6371;
    for (let r = 0; r < h; r++) {
      const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
      const dx = R * Math.max(0.05, Math.cos(lat)) * ((2 * Math.PI) / w);
      const dy = (R * Math.PI) / h;
      const rn = r > 0 ? r - 1 : r;
      const rs = r < h - 1 ? r + 1 : r;
      for (let c = 0; c < w; c++) {
        const ce = c === w - 1 ? 0 : c + 1;
        const cw = c === 0 ? w - 1 : c - 1;
        const gx = (height[r * w + ce] - height[r * w + cw]) / (2 * dx);
        const gy = (height[rn * w + c] - height[rs * w + c]) / (dy * Math.max(1, rs - rn));
        const slope = Math.hypot(gx, gy);
        if (t.inversionSlope > 0) slopeFactor[r * w + c] = Math.exp(-slope / t.inversionSlope);
        if (sheetFactor) {
          const u = slope / t.inversionIceSheetSlope;
          sheetFactor[r * w + c] *= Math.exp(-u * u);
        }
      }
    }
  }
  const S = SOLAR_CONSTANT * Math.max(0, params.solarMultiplier);
  const tilt = (Math.max(0, Math.min(90, params.axialTilt)) * Math.PI) / 180;
  const samples = 6;
  for (let m = 0; m < 12; m++) {
    for (let r = 0; r < h; r++) {
      const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
      const sl = Math.sin(lat);
      const cl = Math.cos(lat);
      let q = 0;
      for (let s = 0; s < samples; s++) {
        const dec = declinationAt((m + (s + 0.5) / samples) / 12, tilt);
        q += dailyInsolation(S, sl, cl, Math.sin(dec), Math.cos(dec)) / samples;
      }
      const dark = Math.min(1, Math.max(0, 1 - q / t.inversionInsolation));
      const k = t.inversionMax * Math.pow(dark, t.inversionPower);
      const kSheet = t.inversionIceSheetExtra * Math.pow(dark, t.inversionPower);
      if (k <= 0) continue;
      const off = m * N + r * w;
      for (let c = 0; c < w; c++) {
        if (!land[r * w + c]) continue;
        const sn = snow[off + c];
        if (!(sn > 0)) continue;
        const clear = useCloud ? Math.min(1, Math.max(0, (t.inversionCloudOvercast - cloud![off + c]) / cloudSpan)) : 1;
        const dT = k * slopeFactor[r * w + c] + (sheetFactor ? kSheet * sheetFactor[r * w + c] : 0);
        temp[off + c] -= dT * Math.min(1, sn) * clear;
      }
    }
  }
}
