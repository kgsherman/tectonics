/**
 * Temperature of the water brought up by upwelling (SPEC §6.1.7): T_sub ≈ zonal annual SST − ΔT,
 * refined by a thermocline tilt. Under the trades the thermocline shoals toward the eastern side of
 * each basin (equatorial cold tongues, eastern-boundary upwelling off California, Peru, Namibia,
 * the Canaries) and deepens toward the west (warm pools, western-intensified gyres), so T_sub is
 * colder in the east and warmer in the west of each row segment of ocean. On a retrograde planet
 * everything is mirrored (trades blow from the west, gyres intensify in the east). Where the surface
 * is colder than the deep water (polar oceans: T_sub ≥ deepWaterT), upwelling warms the surface.
 */
import type { LatLonGrid } from './dynGrid';
import { ebmTuning, oceanTuning, windTuning } from './tuning';

/**
 * Per-cell T_sub (°C, n) from monthly SST and surface zonal wind (12·n each, core grid).
 */
export function subsurfaceTemperature(g: LatLonGrid, land: Uint8Array, sst: Float64Array, windU: Float64Array, retrograde: boolean): Float64Array {
  const rot = retrograde ? -1 : 1;
  const t = ebmTuning;
  const { nx, ny, n } = g;
  const out = new Float64Array(n);
  const tauRef = oceanTuning.thermoclineTiltStressRef;
  const k = windTuning.rhoAir * oceanTuning.dragCoeff;
  for (let j = 0; j < ny; j++) {
    // Zonal annual-mean SST and ocean-mean zonal stress of the row.
    let s = 0;
    let cnt = 0;
    let tau = 0;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (land[i]) continue;
      for (let m = 0; m < 12; m++) {
        s += sst[m * n + i];
        const u = windU[m * n + i];
        tau += k * Math.abs(u) * u;
      }
      cnt += 12;
    }
    const zonal = cnt > 0 ? s / cnt : t.freezeT;
    // Polar oceans are temperature-inverted: cold, fresh surface water lies on warmer, saltier
    // deep water (Circumpolar Deep Water, the Atlantic layer), so upwelling there brings heat up.
    const base = Math.max(zonal - t.upwellingDeltaT, Math.min(zonal + t.upwellingDeltaT, t.deepWaterT));
    // Trade-wind stress (easterly on a prograde planet) tilts the thermocline (weight 0..1);
    // positive tilt makes the eastern side (prograde) / western side (retrograde) colder.
    const trade = cnt > 0 ? Math.min(1, Math.max(0, (-rot * tau) / cnt / tauRef)) : 0;
    const tilt = rot * t.upwellingTiltDeltaT * trade;
    // Position of each ocean cell within its row segment: 0 = western coast, 1 = eastern coast.
    let firstLand = -1;
    for (let c = 0; c < nx; c++) if (land[j * nx + c]) { firstLand = c; break; }
    if (firstLand < 0 || tilt === 0) {
      for (let c = 0; c < nx; c++) out[j * nx + c] = Math.max(t.freezeT, base);
      continue;
    }
    let q = 0;
    while (q < nx) {
      const c0 = (firstLand + q) % nx;
      if (land[j * nx + c0]) {
        out[j * nx + c0] = Math.max(t.freezeT, base);
        q++;
        continue;
      }
      let len = 0;
      while (q + len < nx && !land[j * nx + ((firstLand + q + len) % nx)]) len++;
      for (let a = 0; a < len; a++) {
        const pos = len > 1 ? a / (len - 1) : 0.5;
        const i = j * nx + ((firstLand + q + a) % nx);
        out[i] = Math.max(t.freezeT, base - tilt * (2 * pos - 1));
      }
      q += len;
    }
  }
  return out;
}
