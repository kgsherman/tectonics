/**
 * Cloud structure of the energy balance (pass 2): a planetary-albedo offset per cell and month from
 * the dynamics' own cloud regimes, added to the zonal snow-free albedo albedoBase + albedoP2·P2(sinφ):
 *  - large-scale subsidence (negative `ascent`) clears the sky: darker land and ocean (deserts,
 *    subtropical highs); convergence over land builds convective cloud (monsoons, summer heat lows);
 *  - storm tracks (baroclinic index, half monthly and half annual mean: the extratropical cloud
 *    decks persist through the seasons) are bright;
 *  - marine stratocumulus over water colder than its latitude (upwelling coasts, cold currents) is
 *    bright, more so under subsidence (the inversion that traps it).
 *
 * The offsets are built before the coupled pass 2 from the pass-1 SST, which has neither currents
 * nor upwelling; without correction the cold-water term missed the upwelling decks (Peru, Namibia,
 * Canaries) entirely. With `upwellLambda`/`tSub` (the pass-2 upwelling damping and source
 * temperature) the SST is first lowered by the local equilibrium upwelling cooling of the ocean
 * step, λ_u·(SST − T_sub)/(B + γ + λ_u), so the cold-water anomaly includes the upwelling tongues.
 */
import type { Circulation } from './circulation';
import type { LatLonGrid } from './dynGrid';
import { cloudAlbedoTuning, ebmTuning } from './tuning';

export function cloudAlbedoOffset(
  g: LatLonGrid,
  land: Uint8Array,
  circ: Circulation,
  sst: Float64Array,
  upwellLambda: Float64Array | null = null,
  tSub: Float64Array | null = null,
): Float64Array {
  const t = cloudAlbedoTuning;
  const { nx, ny, n } = g;
  const out = new Float64Array(12 * n);
  const baroAnn = new Float64Array(n);
  for (let m = 0; m < 12; m++) for (let i = 0; i < n; i++) baroAnn[i] += circ.baroclinic[m * n + i] / 12;
  // Annual (upwelling-corrected) SST per ocean cell.
  const restore = ebmTuning.olrB + ebmTuning.airSeaExchange;
  const ann = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    let a = 0;
    for (let m = 0; m < 12; m++) {
      const s = sst[m * n + i];
      const lu = upwellLambda && tSub ? upwellLambda[m * n + i] : 0;
      a += (lu > 0 ? s - (lu * (s - tSub![i])) / (restore + lu) : s) / 12;
    }
    ann[i] = a;
  }
  // Annual SST anomaly relative to the ocean zonal mean of each row (cold coasts > 0).
  const cold = new Float64Array(n);
  for (let j = 0; j < ny; j++) {
    let s = 0;
    let k = 0;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (land[i]) continue;
      s += ann[i];
      k++;
    }
    if (k === 0) continue;
    const zonal = s / k;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (land[i]) continue;
      cold[i] = Math.max(0, Math.min(1, (zonal - ann[i]) / t.stratusRefK));
    }
  }
  for (let m = 0; m < 12; m++) {
    const o = m * n;
    for (let i = 0; i < n; i++) {
      const asc = circ.ascent[o + i];
      const sub = Math.min(t.subsidenceMax, Math.max(0, -asc));
      const storm = Math.min(t.stormMax, Math.max(0, (1 - t.stormAnnualWeight) * circ.baroclinic[o + i] + t.stormAnnualWeight * baroAnn[i]));
      if (land[i]) {
        out[o + i] = -t.subsidenceLand * sub + t.ascentLand * Math.min(t.ascentMax, Math.max(0, asc)) + t.stormLand * storm;
      } else {
        const sc = t.stratus * cold[i] * (1 + t.stratusSubsidence * sub);
        out[o + i] = -t.subsidenceOcean * sub + t.stormOcean * storm + sc;
      }
    }
  }
  return out;
}
