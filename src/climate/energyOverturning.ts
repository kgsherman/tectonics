/**
 * Interhemispheric overturning ("Drake Passage effect", Toggweiler & Samuels 1995; Toggweiler &
 * Bjornsson 2000): when exactly one hemisphere has a zonally open ocean channel at subpolar
 * latitudes, its westerlies drive a northward (equatorward) Ekman transport across the channel that
 * cannot be returned geostrophically at the surface. The water sinks in the far basin of the other
 * hemisphere and returns at depth, so the ocean carries heat from the channel hemisphere's
 * subtropics and mid-latitudes into the closed hemisphere's subpolar ocean (Earth: the Atlantic
 * overturning warms the northern North Atlantic and Nordic Seas while the Southern Hemisphere loses
 * heat). With channels in both hemispheres or in neither the cells cancel and nothing is applied.
 *
 * Represented as a steady ocean heat source Q (W/m², per ocean cell) that sums to zero over the
 * globe: cooling spread over the channel hemisphere's ocean between 15° and 60° (triangular in
 * latitude, peak at 40°) and warming over the closed hemisphere's ocean at 38–70° (peak at 55°) in
 * the basins that connect through wide passages to its polar ocean (dense water forms next to the
 * polar sea; Earth: the Atlantic and Nordic Seas, not the Pacific behind Bering Strait), each
 * normalized by the ocean area it covers. Strength ∝ how completely the channel ring is open.
 */
import type { LatLonGrid } from './dynGrid';
import { ebmTuning } from './tuning';

const DEG = Math.PI / 180;

/** Longest ocean run of a row as a fraction of the latitude circle (1 = fully open). */
function rowOpenness(g: LatLonGrid, land: Uint8Array, j: number): number {
  const { nx } = g;
  let best = 0;
  let run = 0;
  let all = true;
  for (let k = 0; k < 2 * nx; k++) {
    if (!land[j * nx + (k % nx)]) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
      all = false;
    }
  }
  return all ? 1 : Math.min(1, best / nx);
}

/** Channel strength 0..1 of a hemisphere (sign +1 north, −1 south): max openness over 45–70°. */
function channelStrength(g: LatLonGrid, land: Uint8Array, sign: number): number {
  let best = 0;
  for (let j = 0; j < g.ny; j++) {
    const la = (g.lat[j] / DEG) * sign;
    if (la < 45 || la > 70) continue;
    best = Math.max(best, rowOpenness(g, land, j));
  }
  // Only a (nearly) complete ring counts: a long but blocked ocean row is a basin, not a channel.
  return Math.min(1, Math.max(0, (best - 0.9) / 0.1));
}

function tri(x: number, a: number, peak: number, b: number): number {
  if (x <= a || x >= b) return 0;
  return x < peak ? (x - a) / (peak - a) : (b - x) / (b - peak);
}

/**
 * Per-cell ocean heat source (W/m², n; 0 over land) of the interhemispheric overturning, or null
 * when it is off (no single-hemisphere channel or zero strength).
 */
export function overturningHeating(g: LatLonGrid, land: Uint8Array): Float64Array | null {
  const t = ebmTuning;
  if (!(t.overturningPW > 0)) return null;
  const sN = channelStrength(g, land, 1);
  const sS = channelStrength(g, land, -1);
  const net = sS - sN; // > 0: southern channel → northward overturning heat transport
  if (Math.abs(net) < 1e-3) return null;
  const toNorth = net > 0 ? 1 : -1;
  const F0 = t.overturningPW * 1e15 * Math.abs(net);
  const { nx, ny, n } = g;
  const R2 = 6.371e6 * 6.371e6;
  // Latitude measured toward the sinking hemisphere: channel side < 0, sinking side > 0.
  const laOf = (j: number): number => (g.lat[j] / DEG) * toNorth;
  // The sinking water is released in the basins that connect to the polar ocean (dense water forms
  // where subpolar water can be cooled next to the polar sea): flood through ocean cells from the
  // polar ocean (≥ 75°) down to 38°. Without a polar ocean every basin qualifies.
  // Only wide passages count (a strait like Bering does not carry basin-scale exchange): the flood
  // runs through "wide" ocean cells (every cell within 1 row and 2 columns is ocean) and the reached
  // set is then dilated by the same neighbourhood to include the coastal ocean.
  const neighbours = (i: number, out: Int32Array): number => {
    const j = (i / nx) | 0;
    const c = i - j * nx;
    let k = 0;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= ny) continue;
      for (let dc = -2; dc <= 2; dc++) {
        if (dj === 0 && dc === 0) continue;
        out[k++] = jj * nx + ((c + dc + nx) % nx);
      }
    }
    return k;
  };
  const nb = new Int32Array(14);
  const wide = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    let ok = 1;
    const k = neighbours(i, nb);
    for (let q = 0; q < k; q++) if (land[nb[q]]) ok = 0;
    wide[i] = ok;
  }
  const core = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  for (let j = 0; j < ny; j++) {
    if (laOf(j) < 75) continue;
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (wide[i]) {
        core[i] = 1;
        stack[top++] = i;
      }
    }
  }
  const four = new Int32Array(4);
  while (top > 0) {
    const i = stack[--top];
    const j = (i / nx) | 0;
    const c = i - j * nx;
    four[0] = j * nx + (c === 0 ? nx - 1 : c - 1);
    four[1] = j * nx + (c === nx - 1 ? 0 : c + 1);
    four[2] = j > 0 ? i - nx : -1;
    four[3] = j < ny - 1 ? i + nx : -1;
    for (let q = 0; q < 4; q++) {
      const k = four[q];
      if (k < 0 || core[k] || !wide[k] || laOf((k / nx) | 0) < 38) continue;
      core[k] = 1;
      stack[top++] = k;
    }
  }
  const reach = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!core[i]) continue;
    reach[i] = 1;
    const k = neighbours(i, nb);
    for (let q = 0; q < k; q++) if (!land[nb[q]]) reach[nb[q]] = 1;
  }
  let reachA = 0;
  for (let i = 0; i < n; i++) if (reach[i]) reachA += g.area[(i / nx) | 0];
  const anyBasin = reachA > 0.002 * 4 * Math.PI;
  const up = new Float64Array(ny);
  const rel = new Float64Array(ny);
  let upA = 0;
  let relA = 0;
  for (let j = 0; j < ny; j++) {
    const la = laOf(j);
    up[j] = tri(la, -60, -40, -15);
    rel[j] = tri(la, 38, 55, 70);
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (land[i]) continue;
      const a = g.area[j] * R2;
      upA += up[j] * a;
      if (!anyBasin || reach[i]) relA += rel[j] * a;
    }
  }
  if (!(upA > 0 && relA > 0)) return null;
  const out = new Float64Array(n);
  for (let j = 0; j < ny; j++) {
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (land[i]) continue;
      const r = !anyBasin || reach[i] ? rel[j] / relA : 0;
      out[i] = F0 * (r - up[j] / upA);
    }
  }
  return out;
}
