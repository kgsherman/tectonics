import { EARTH_RADIUS_KM } from '../core/constants';
import type { Noise3 } from '../core/noise';
import { createNoise3, fbm3 } from '../core/noise';
import { cellsWithinRadius } from '../core/sphereMesh';
import type { SphereMesh, Vec3 } from '../core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../core/types';
import type { EditState } from './editState';
import { COAST_INFLUENCE_KM, DEFAULT_OCEAN_AGE } from './editorConstants';

/** Per-cell noise inputs of the painted-continent profile, each ≈ [−1, 1]. */
export interface ReliefNoise {
  /** Low-frequency (~2500 km) field: shelf width and broad basins/swells. */
  low: number;
  /** Mid-frequency (~600 km) field: shelf and coastal-plain breakup. */
  mid: number;
  /** Undulation of the continental base (basins and swells). */
  und: number;
  /** Upland field: inland plateaus where it is high. */
  up: number;
  /** Ridged field 0..1 (1 on ridge crests): old, eroded mountain belts. */
  ridge: number;
  /** Low-frequency gate deciding where old belts exist at all. */
  gate: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Elevation (m) of a continent-brush cell from its distance to the nearest ocean cell centre and
 * per-cell noise (same recipe as the random generator's continents, evaluated locally):
 *  - an emergence potential (coast distance + noise) below zero gives a continental SHELF, −15 m at
 *    the shoreline to ~−200 m at the shelf break; the outermost ring of cells (the edge of the
 *    continental crust) is always shelf, and noise widens it to a few hundred km in places (broad
 *    shelves, narrow shelves, the odd epicontinental bay);
 *  - above zero, land rises gently from a low coastal plain (so the painter's coastline breakup has
 *    room to make organic coasts) to a ~+400 m continental base with broad basins and swells,
 *    occasional dissected plateaus well inland and old, eroded mountain belts (≤ ~1.4 km).
 * Young mountains are left to the tectonic simulation (convergent boundaries).
 */
export function continentProfile(coastKm: number, spacingKm: number, nz: ReliefNoise): number {
  const d = Math.max(0, coastKm - spacingKm);
  let pot = d / 300 + 0.7 * nz.low + 0.25 * nz.mid - 0.1;
  // The outermost ring of continental crust is always submerged: it is the shelf edge.
  if (coastKm < 1.5 * spacingKm) pot = Math.min(pot, -0.2);
  if (pot < 0) return -(15 + 185 * smoothstep(0, 0.45, -pot));
  const ramp = 1 - Math.exp(-pot / 0.7);
  const inland = smoothstep(120, 650, d);
  const undulate = 240 * nz.und + 70 * nz.mid;
  const plateau = 1300 * inland * smoothstep(0.2, 0.65, nz.up);
  const belts = 1050 * smoothstep(60, 350, d) * smoothstep(0.05, 0.45, nz.gate) * nz.ridge * nz.ridge * nz.ridge;
  const h = ramp * (400 + undulate + plateau + belts) + 8;
  return Math.max(2 + 20 * ramp, Math.min(3200, h));
}

/** Raise/Lower dab falloff: raised cosine, 1 at the centre, 0 at the rim (d, r in radians). */
export function raiseKernel(d: number, r: number): number {
  if (d >= r) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / r));
}

/** Small binary min-heap of (key, value) pairs used by the local coast-distance Dijkstra. */
class MinHeap {
  private keys = new Float64Array(64);
  private vals = new Int32Array(64);
  size = 0;
  /** Key of the entry returned by the last pop(). */
  lastKey = 0;

  push(k: number, v: number): void {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.size * 2);
      nk.set(this.keys);
      this.keys = nk;
      const nv = new Int32Array(this.size * 2);
      nv.set(this.vals);
      this.vals = nv;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= k) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = k;
    this.vals[i] = v;
  }

  /** Pops the minimum and returns its value (its key is left in lastKey). */
  pop(): number {
    const topV = this.vals[0];
    this.lastKey = this.keys[0];
    const k = this.keys[--this.size];
    const v = this.vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= k) break;
      this.keys[i] = this.keys[c];
      this.vals[i] = this.vals[c];
      i = c;
    }
    this.keys[i] = k;
    this.vals[i] = v;
    return topV;
  }

  clear(): void {
    this.size = 0;
  }
}

/**
 * Procedural relief for the continent / ocean brushes. Keeps a lazily filled per-cell noise cache
 * (seeded by the draft seed) and recomputes brush-painted continental elevations from coast
 * distances in a local region after each batch of dabs.
 */
export class ReliefModel {
  private readonly noise: Noise3;
  private readonly nLow: Noise3;
  private readonly nMid: Noise3;
  private readonly nUnd: Noise3;
  private readonly nUp: Noise3;
  private readonly nRidge: Noise3;
  /** 6 channels per cell (ReliefNoise order), NaN until first used. */
  private readonly noiseCache: Float32Array;
  private readonly nz: ReliefNoise = { low: 0, mid: 0, und: 0, up: 0, ridge: 0, gate: 0 };
  private readonly local: Int32Array;
  private readonly localGen: Int32Array;
  private gen = 0;
  private readonly heap = new MinHeap();
  private readonly region: number[] = [];
  private readonly spacingKm: number;

  constructor(private readonly mesh: SphereMesh, seed: number) {
    const base = ((seed | 0) * 7 + 11) >>> 0;
    this.noise = createNoise3(base);
    this.nLow = createNoise3(base + 1);
    this.nMid = createNoise3(base + 2);
    this.nUnd = createNoise3(base + 3);
    this.nUp = createNoise3(base + 4);
    this.nRidge = createNoise3(base + 5);
    this.noiseCache = new Float32Array(6 * mesh.n).fill(NaN);
    this.local = new Int32Array(mesh.n);
    this.localGen = new Int32Array(mesh.n);
    this.spacingKm = mesh.spacing * EARTH_RADIUS_KM;
  }

  /** Relief noise of cell i (cached; the returned object is reused by the next call). */
  noiseAt(i: number): ReliefNoise {
    const c = this.noiseCache;
    const o = 6 * i;
    if (c[o] !== c[o]) {
      const x = this.mesh.xyz[3 * i], y = this.mesh.xyz[3 * i + 1], z = this.mesh.xyz[3 * i + 2];
      const cl = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);
      c[o] = cl(1.6 * fbm3(this.nLow, 2.5 * x, 2.5 * y, 2.5 * z, 4));
      c[o + 1] = cl(1.6 * fbm3(this.nMid, 11 * x, 11 * y, 11 * z, 3));
      c[o + 2] = cl(1.6 * fbm3(this.nUnd, 3.2 * x + 7, 3.2 * y, 3.2 * z, 4));
      c[o + 3] = cl(1.6 * (fbm3(this.nUp, 1.5 * x, 1.5 * y, 1.5 * z, 2) + 0.25 * fbm3(this.nMid, 6 * x + 3, 6 * y, 6 * z, 3)));
      // Ridged: 1 on the zero set of a band-limited field → sinuous belts ~300 km wide.
      c[o + 4] = 1 - Math.min(1, Math.abs(2.2 * fbm3(this.nRidge, 4.5 * x, 4.5 * y, 4.5 * z, 3)));
      c[o + 5] = cl(1.6 * fbm3(this.nRidge, 1.3 * x + 11, 1.3 * y, 1.3 * z, 2));
    }
    const nz = this.nz;
    nz.low = c[o];
    nz.mid = c[o + 1];
    nz.und = c[o + 2];
    nz.up = c[o + 3];
    nz.ridge = c[o + 4];
    nz.gate = c[o + 5];
    return nz;
  }

  /** Noise function (for rough dab footprints). */
  get noiseFn(): Noise3 {
    return this.noise;
  }

  /**
   * Recompute the elevation of every brush-painted continental cell within `reach` radians of
   * `center` from its distance to the nearest oceanic cell (searched up to COAST_INFLUENCE_KM
   * further out). `touch(i)` is called before a cell is modified; modified cells are appended to
   * `changed`.
   */
  updateCoastalRelief(state: EditState, center: Vec3, reach: number, touch: (i: number) => void, changed: number[]): void {
    const { mesh } = this;
    const { xyz, adjOffset, adj } = mesh;
    const d = state.draft;
    const infl = COAST_INFLUENCE_KM / EARTH_RADIUS_KM;
    const region = cellsWithinRadius(mesh, center, Math.min(Math.PI, reach + 2 * infl + mesh.spacing), this.region);
    this.gen++;
    if (this.gen >= 0x7fffffff) {
      this.localGen.fill(0);
      this.gen = 1;
    }
    const g = this.gen;
    const m = region.length;
    const dist = new Float64Array(m).fill(Infinity);
    const heap = this.heap;
    heap.clear();
    for (let k = 0; k < m; k++) {
      const i = region[k];
      this.local[i] = k;
      this.localGen[i] = g;
      if (d.crust[i] === CRUST_OCEANIC) {
        dist[k] = 0;
        heap.push(0, k);
      }
    }
    const R = EARTH_RADIUS_KM;
    while (heap.size > 0) {
      const k = heap.pop();
      const dk = heap.lastKey;
      if (dk > dist[k] || dk > COAST_INFLUENCE_KM) continue;
      const i = region[k];
      const ix = xyz[3 * i], iy = xyz[3 * i + 1], iz = xyz[3 * i + 2];
      for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
        const j = adj[e];
        if (this.localGen[j] !== g) continue;
        const q = this.local[j];
        // Chord length ≈ arc length for neighbouring cells (error < 0.01% at 1°).
        const w = Math.hypot(xyz[3 * j] - ix, xyz[3 * j + 1] - iy, xyz[3 * j + 2] - iz) * R;
        const nd = dk + w;
        if (nd < dist[q]) {
          dist[q] = nd;
          heap.push(nd, q);
        }
      }
    }
    const cosReach = Math.cos(Math.min(Math.PI, reach + infl));
    for (let k = 0; k < m; k++) {
      const i = region[k];
      if (!state.brushRelief[i] || d.crust[i] !== CRUST_CONTINENTAL) continue;
      if (xyz[3 * i] * center[0] + xyz[3 * i + 1] * center[1] + xyz[3 * i + 2] * center[2] < cosReach) continue;
      const coastKm = Math.min(COAST_INFLUENCE_KM, dist[k]);
      const e = continentProfile(coastKm, this.spacingKm, this.noiseAt(i));
      if (Math.abs(e - d.elev[i]) < 0.01) continue;
      touch(i);
      d.elev[i] = e;
      changed.push(i);
    }
  }
}

/** Mean age of each plate's oceanic crust (DEFAULT_OCEAN_AGE for plates without any). */
export function plateOceanAges(state: EditState): Float64Array {
  const d = state.draft;
  const np = d.plates.length;
  const sum = new Float64Array(np), cnt = new Float64Array(np);
  for (let i = 0; i < d.n; i++) {
    if (d.crust[i] !== CRUST_OCEANIC) continue;
    const a = d.age[i];
    if (!(a >= 0) || !Number.isFinite(a)) continue;
    sum[d.plate[i]] += a;
    cnt[d.plate[i]]++;
  }
  const out = new Float64Array(np);
  for (let k = 0; k < np; k++) out[k] = cnt[k] > 0 ? Math.max(5, Math.min(180, sum[k] / cnt[k])) : DEFAULT_OCEAN_AGE;
  return out;
}
