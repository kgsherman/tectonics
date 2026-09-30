import { EARTH_RADIUS_KM } from '../core/constants';
import { createNoise3, fbm3 } from '../core/noise';
import type { Rng } from '../core/rng';
import type { SphereMesh } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';
import { oceanDepthForAge } from './genCommon';
import type { ContinentInfo } from './genContinents';
import type { Components } from './genGraph';
import { multiSourceDijkstra } from './genGraph';
import type { BoundaryKinematics } from './genKinematics';
import { oldRanges, tectonicBelts } from './genRanges';

// Elevation and continental age at t = 0.
//  * Continents: an emergence potential (distance from the coast + low-frequency noise, boosted near
//    active margins) is thresholded at a per-world quantile so that 70–80% of continental crust is
//    land; the rest forms shelves / epicontinental seas (−20…−250 m). Land rises from low coastal
//    plains to a +350…+550 m continental base with broad basins and swells, dissected inland
//    plateaus, higher flat cratonic cores, old eroded ranges and tectonic belts consistent with the
//    plate motions.
//  * Ocean: depth from crust age (plate cooling) plus a continental rise on passive margins.

const KM = 1 / EARTH_RADIUS_KM;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface ReliefResult {
  elev: Float32Array;
  /** Continental crust ages filled in (oceanic ages copied from the input). */
  age: Float32Array;
  orogeny: Float32Array;
}

/** Flat-topped craton factor 0..1 per continental cell (1–3 cratons per large continent). */
function cratonField(mesh: SphereMesh, comps: Components, coastKm: Float32Array, rng: Rng, noiseSeed: number): Float32Array {
  const { n, xyz } = mesh;
  const out = new Float32Array(n);
  const warp = createNoise3(noiseSeed + 41);
  // Candidate interior cells per continent, and each continent's max coast distance.
  const byComp = new Map<number, number[]>();
  const maxD = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const c = comps.comp[i];
    if (c < 0) continue;
    maxD.set(c, Math.max(maxD.get(c) ?? 0, coastKm[i]));
  }
  for (let i = 0; i < n; i++) {
    const c = comps.comp[i];
    if (c < 0 || comps.size[c] < n * 0.008) continue;
    if (coastKm[i] < 0.45 * (maxD.get(c) ?? 0)) continue;
    let l = byComp.get(c);
    if (!l) byComp.set(c, (l = []));
    l.push(i);
  }
  const centers: number[] = [];
  const radii: number[] = [];
  const compOf: number[] = [];
  for (const [c, cells] of [...byComp.entries()].sort((a, b) => a[0] - b[0])) {
    const k = Math.min(3, 1 + Math.floor(comps.size[c] / (n * 0.05)));
    const areaRad = Math.sqrt((comps.size[c] * mesh.cellArea) / Math.PI);
    for (let q = 0; q < k; q++) {
      centers.push(cells[rng.int(0, cells.length)]);
      radii.push(areaRad * rng.float(0.3, 0.5));
      compOf.push(c);
    }
  }
  for (let i = 0; i < n; i++) {
    const c = comps.comp[i];
    if (c < 0) continue;
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    const wv = 1 + 0.35 * fbm3(warp, x * 4, y * 4, z * 4, 3);
    let f = 0;
    for (let q = 0; q < centers.length; q++) {
      if (compOf[q] !== c) continue;
      const s = centers[q];
      const d = Math.acos(Math.max(-1, Math.min(1, x * xyz[3 * s] + y * xyz[3 * s + 1] + z * xyz[3 * s + 2])));
      f = Math.max(f, 1 - smoothstep(0.55, 1.1, (d / radii[q]) * wv));
    }
    out[i] = f;
  }
  return out;
}

/**
 * Build t = 0 elevation (m), continental ages and young-orogeny fields.
 * `oceanAge` holds oceanic crust ages (continental entries ignored).
 */
export function buildRelief(mesh: SphereMesh, plate: Int16Array, crust: Uint8Array, continents: ContinentInfo, oceanAge: Float32Array, kin: BoundaryKinematics, rng: Rng, noiseSeed: number): ReliefResult {
  const { n, xyz } = mesh;
  const elev = new Float32Array(n);
  const age = oceanAge.slice();
  const cont = new Uint8Array(n);
  let contCount = 0;
  for (let i = 0; i < n; i++) {
    cont[i] = crust[i] === CRUST_CONTINENTAL ? 1 : 0;
    contCount += cont[i];
  }
  const { comps, coastKm } = continents;
  const low = createNoise3(noiseSeed + 51);
  const mid = createNoise3(noiseSeed + 52);
  const ridgeNoise = createNoise3(noiseSeed + 53);
  const upland = createNoise3(noiseSeed + 54);
  const belts = tectonicBelts(mesh, plate, crust, kin, ridgeNoise, rng);
  const ranges = oldRanges(mesh, crust, comps, coastKm, ridgeNoise, rng);
  const craton = cratonField(mesh, comps, coastKm, rng, noiseSeed);

  // --- Continents: emergence potential and shelf threshold -------------------------------------
  const potential = new Float32Array(n);
  const contPot: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!cont[i]) continue;
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    // Noise dominates near the coast so shelf width varies (broad shelves, epicontinental seas,
    // narrow shelves) instead of forming a uniform halo.
    const p = coastKm[i] / 400 + 1.6 * fbm3(low, x * 2.5, y * 2.5, z * 2.5, 4) + 0.6 * fbm3(mid, x * 11, y * 11, z * 11, 3) + 2.5 * belts.activeMargin[i] + 0.8 * craton[i];
    potential[i] = p;
    contPot.push(p);
  }
  const submergedFrac = rng.float(0.2, 0.3);
  contPot.sort((a, b) => a - b);
  const thr = contPot.length > 0 ? contPot[Math.min(contPot.length - 1, Math.floor(submergedFrac * contPot.length))] : 0;
  const baseLevel = rng.float(350, 550);
  const cratonLift = rng.float(200, 450);

  for (let i = 0; i < n; i++) {
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    if (!cont[i]) {
      elev[i] = oceanDepthForAge(age[i]);
      continue;
    }
    const pAbove = potential[i] - thr;
    const tect = belts.uplift[i] + ranges[i];
    let h: number;
    if (pAbove < 0) {
      // Shelf / epicontinental sea: shallow near the shoreline, ~−200 m at the shelf break.
      h = -(20 + 230 * smoothstep(0, 0.9, -pAbove)) + 0.3 * Math.max(0, tect);
      h = Math.min(h, -5);
    } else {
      // Coastal plain → continental base with broad basins/swells, occasional high plateaus well
      // inland (Colorado / Ethiopia / Deccan style) and flat, higher cratons.
      const ramp = 1 - Math.exp(-pAbove / 0.9);
      const undulate = 330 * fbm3(low, x * 3.2 + 7, y * 3.2, z * 3.2, 4) + 70 * fbm3(mid, x * 14, y * 14, z * 14, 3);
      const inland = smoothstep(150, 700, coastKm[i]);
      // Mid-frequency term roughens plateau outlines (escarpments, dissected edges) before the threshold.
      const up = fbm3(upland, x * 1.5, y * 1.5, z * 1.5, 2) + 0.25 * fbm3(mid, x * 6 + 3, y * 6, z * 6, 3);
      const plateau = 1800 * inland * smoothstep(0.1, 0.6, up);
      h = ramp * (baseLevel + undulate + cratonLift * craton[i] + plateau) + tect + 8;
      h = Math.max(h, 2 + 20 * ramp);
    }
    elev[i] = h;
    // Continental ages: ancient cratons, Proterozoic platforms, younger margins and active belts.
    const interior = smoothstep(0, 1500, coastKm[i]);
    let a = 450 + 1100 * interior + 1700 * craton[i] + 150 * fbm3(mid, x * 5, y * 5, z * 5, 2);
    if (ranges[i] > 150) a = Math.min(a, 320 + 180 * fbm3(mid, x * 3, y * 3, z * 3, 2));
    if (belts.orogeny[i] > 200) a = Math.min(a, 40 + 120 * (1 - belts.activeMargin[i]));
    age[i] = Math.max(20, a);
  }

  // --- Ocean: continental rise on passive margins ---------------------------------------------
  if (contCount > 0) {
    const rise = passiveMarginRise(mesh, plate, cont);
    for (let i = 0; i < n; i++) if (rise[i] > 0) elev[i] += (MARGIN_RISE_DEPTH - elev[i]) * rise[i];
  }
  return { elev, age, orogeny: belts.orogeny };
}

/** Depth (m) the continental rise pulls the sea floor toward right at a passive margin. */
export const MARGIN_RISE_DEPTH = -1300;

/**
 * Continental-rise weight (0…0.65, decaying over ~200 km) for oceanic cells of the same plate as the
 * adjacent continental crust — the rise stops at plate boundaries, so the floor beyond a trench keeps
 * its age depth. Blend the sea floor toward MARGIN_RISE_DEPTH by this weight.
 */
export function passiveMarginRise(mesh: SphereMesh, plate: Int16Array, contMask: Uint8Array): Float32Array {
  const n = mesh.n;
  const out = new Float32Array(n);
  const ocean = new Uint8Array(n);
  for (let i = 0; i < n; i++) ocean[i] = contMask[i] ? 0 : 1;
  const src: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!ocean[i]) continue;
    for (let e = mesh.adjOffset[i]; e < mesh.adjOffset[i + 1]; e++) {
      const j = mesh.adj[e];
      if (contMask[j] && plate[j] === plate[i]) {
        src.push(i);
        break;
      }
    }
  }
  if (src.length === 0) return out;
  const { dist } = multiSourceDijkstra(mesh, src, src.map(() => 0), { mask: ocean, sameLabel: plate, maxDist: 300 * KM });
  for (let i = 0; i < n; i++) {
    if (!ocean[i] || !(dist[i] < Infinity)) continue;
    const d = dist[i] / KM;
    out[i] = 0.65 * Math.exp(-((d / 90) ** 2));
  }
  return out;
}
