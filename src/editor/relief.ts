import { EARTH_RADIUS_KM } from '../core/constants';
import type { Noise3 } from '../core/noise';
import { createNoise3, fbm3 } from '../core/noise';
import { cellsWithinRadius } from '../core/sphereMesh';
import type { SphereMesh, Vec3 } from '../core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../core/types';
import type { EditState } from './editState';
import { COAST_INFLUENCE_KM, DEFAULT_OCEAN_AGE } from './editorConstants';

/**
 * Elevation of a continent-brush cell (m) from its distance to the nearest ocean cell centre and a
 * smooth noise value n ≈ [−1, 1]. The outermost ring of cells (coastKm ≈ one spacing) is shelf at
 * about −150 m at every mesh resolution; land rises over a few hundred km to low plains (~+450 m)
 * whose relief grows inland (rolling hills and a few uplands). Mountains are left to tectonics.
 */
export function continentProfile(coastKm: number, spacingKm: number, n: number): number {
  const d = Math.max(0, coastKm - spacingKm);
  const base = -150 + 600 * (1 - Math.exp(-d / 220));
  const inland = 1 - Math.exp(-d / 350);
  const relief = inland * (500 * n + 350 * Math.max(0, n - 0.2));
  return Math.max(-200, Math.min(2200, base + relief));
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
  private readonly noiseCache: Float32Array;
  private readonly local: Int32Array;
  private readonly localGen: Int32Array;
  private gen = 0;
  private readonly heap = new MinHeap();
  private readonly region: number[] = [];
  private readonly spacingKm: number;

  constructor(private readonly mesh: SphereMesh, seed: number) {
    this.noise = createNoise3(((seed | 0) * 7 + 11) >>> 0);
    this.noiseCache = new Float32Array(mesh.n).fill(NaN);
    this.local = new Int32Array(mesh.n);
    this.localGen = new Int32Array(mesh.n);
    this.spacingKm = mesh.spacing * EARTH_RADIUS_KM;
  }

  /** Smooth noise value (≈ [−1, 1]) of cell i. */
  noiseAt(i: number): number {
    let v = this.noiseCache[i];
    if (v !== v) {
      const x = this.mesh.xyz[3 * i], y = this.mesh.xyz[3 * i + 1], z = this.mesh.xyz[3 * i + 2];
      v = fbm3(this.noise, 2.2 * x, 2.2 * y, 2.2 * z, 5) * 1.6;
      this.noiseCache[i] = v;
    }
    return v;
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
