import type { SphereMesh } from '../core/types';

// Graph algorithms on the mesh's Delaunay adjacency used by the generator: a typed binary heap,
// multi-source Dijkstra with optional per-cell costs / label barriers, and connected components.

/** Binary min-heap of (key, value) pairs on typed arrays; duplicates allowed (lazy decrease-key). */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(Math.max(16, capacity));
    this.vals = new Int32Array(Math.max(16, capacity));
  }

  clear(): void {
    this.size = 0;
  }

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.keys.length * 2);
      k.set(this.keys);
      this.keys = k;
      const v = new Int32Array(this.vals.length * 2);
      v.set(this.vals);
      this.vals = v;
    }
    const keys = this.keys, vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** Key of the minimum element (Infinity when empty). */
  peekKey(): number {
    return this.size > 0 ? this.keys[0] : Infinity;
  }

  /** Removes the minimum element and returns its value (caller checks size > 0 first). */
  pop(): number {
    const keys = this.keys, vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n], val = vals[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }
}

const edgeLenCache = new WeakMap<SphereMesh, Float32Array>();

/** Angular length (radians) of every directed adjacency entry mesh.adj[k] (cached per mesh). */
export function edgeLengths(mesh: SphereMesh): Float32Array {
  let el = edgeLenCache.get(mesh);
  if (el) return el;
  const { n, xyz, adjOffset, adj } = mesh;
  el = new Float32Array(adj.length);
  for (let i = 0; i < n; i++) {
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      const j = adj[k];
      const dx = xyz[3 * j] - x, dy = xyz[3 * j + 1] - y, dz = xyz[3 * j + 2] - z;
      const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
      el[k] = 2 * Math.asin(Math.min(1, chord / 2));
    }
  }
  edgeLenCache.set(mesh, el);
  return el;
}

export interface DijkstraOptions {
  /**
   * Per-cell traversal cost multiplier; an edge i→j costs length·(cost[i] + cost[j])/2.
   * Cells with a non-finite cost are impassable. Default 1 everywhere.
   */
  cellCost?: Float32Array;
  /** Propagate only between cells with the same label (e.g. stay within one plate). */
  sameLabel?: Int16Array;
  /** Propagate only into cells with mask[i] !== 0 (sources are always accepted). */
  mask?: Uint8Array;
  /** Per-tag speed: the cost of edges reached from a source with tag t is divided by tagSpeed[t]. */
  tagSpeed?: Float32Array;
  /** Do not expand cells farther than this (same units as the result). Default Infinity. */
  maxDist?: number;
  /** Initial distance per source (default 0). */
  sourceDist?: Float32Array;
  /**
   * Extra cost added to every edge that enters a cell with entryMask[j] !== 0 from a cell with
   * entryMask[i] === 0 (e.g. a front invading a continent from the ocean). Scaled by tagSpeed.
   */
  entryMask?: Uint8Array;
  entryPenalty?: number;
  /**
   * Precomputed cost per adjacency entry (see edgeCostArray); replaces the length / cellCost /
   * entry-penalty computation. Non-finite entries are impassable.
   */
  edgeCost?: Float32Array;
}

/**
 * Per-adjacency-entry cost length·(cost[i] + cost[j])/2 (+ entryPenalty when entering an entryMask
 * cell from outside), for repeated Dijkstra runs over the same cost field.
 */
export function edgeCostArray(mesh: SphereMesh, cellCost: Float32Array, entryMask?: Uint8Array, entryPenalty = 0): Float32Array {
  const { n, adjOffset, adj } = mesh;
  const el = edgeLengths(mesh);
  const out = new Float32Array(adj.length);
  for (let i = 0; i < n; i++) {
    const ci = cellCost[i];
    const outside = entryMask ? entryMask[i] === 0 : false;
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      const j = adj[k];
      let c = el[k] * 0.5 * (ci + cellCost[j]);
      if (outside && entryMask![j] !== 0) c += entryPenalty;
      out[k] = c;
    }
  }
  return out;
}

export interface DijkstraResult {
  /** Distance (radians × cost / speed) to the nearest source; Infinity where unreached. */
  dist: Float64Array;
  /** Tag of the source each cell was reached from; -1 where unreached. */
  tag: Int32Array;
}

/**
 * Multi-source Dijkstra over the mesh graph. `sources[s]` is a cell index and `sourceTag[s]` the tag
 * propagated to the cells it reaches (e.g. a plate index). With `tagSpeed`, fronts carrying different
 * tags advance at different speeds (multiplicatively weighted growth).
 */
export function multiSourceDijkstra(
  mesh: SphereMesh,
  sources: ArrayLike<number>,
  sourceTag: ArrayLike<number>,
  opts: DijkstraOptions = {},
): DijkstraResult {
  const { n, adjOffset, adj } = mesh;
  const el = edgeLengths(mesh);
  // Float64 so the stale-entry test (heap key vs dist) compares identical values.
  const dist = new Float64Array(n).fill(Infinity);
  const tag = new Int32Array(n).fill(-1);
  const { cellCost, sameLabel, mask, tagSpeed, sourceDist, entryMask, edgeCost } = opts;
  const entryPenalty = entryMask ? (opts.entryPenalty ?? 0) : 0;
  const maxDist = opts.maxDist ?? Infinity;
  const heap = new MinHeap(Math.min(8 * n, Math.max(1024, 4 * sources.length)));
  for (let s = 0; s < sources.length; s++) {
    const i = sources[s];
    const d0 = sourceDist ? sourceDist[s] : 0;
    if (d0 < dist[i]) {
      dist[i] = d0;
      tag[i] = sourceTag[s];
      heap.push(d0, i);
    }
  }
  while (heap.size > 0) {
    const d = heap.peekKey();
    const i = heap.pop();
    if (d > dist[i]) continue; // stale entry
    if (d > maxDist) break;
    const t = tag[i];
    const inv = tagSpeed ? 1 / tagSpeed[t] : 1;
    const ci = cellCost ? cellCost[i] : 1;
    const li = sameLabel ? sameLabel[i] : 0;
    const outside = entryMask ? entryMask[i] === 0 : false;
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      const j = adj[k];
      if (sameLabel && sameLabel[j] !== li) continue;
      if (mask && mask[j] === 0) continue;
      let step: number;
      if (edgeCost) {
        step = edgeCost[k];
        if (!(step < Infinity)) continue;
      } else {
        const cj = cellCost ? cellCost[j] : 1;
        if (!(cj < Infinity)) continue;
        step = el[k] * 0.5 * (ci + cj);
        if (outside && entryMask![j] !== 0) step += entryPenalty;
      }
      const nd = d + step * inv;
      if (nd < dist[j]) {
        dist[j] = nd;
        tag[j] = t;
        heap.push(nd, j);
      }
    }
  }
  return { dist, tag };
}

export interface Components {
  /** Component id per cell (-1 for excluded cells). */
  comp: Int32Array;
  /** Cell count per component. */
  size: number[];
  /** Key value shared by the component's cells. */
  key: number[];
  /** One cell of each component. */
  first: number[];
}

/**
 * Connected components of cells sharing the same `key` value. Cells with include[i] === 0 (when
 * given) are excluded (comp = -1).
 */
export function labelComponents(mesh: SphereMesh, key: ArrayLike<number>, include?: Uint8Array): Components {
  const { n, adjOffset, adj } = mesh;
  const comp = new Int32Array(n).fill(-1);
  const size: number[] = [];
  const keys: number[] = [];
  const first: number[] = [];
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || (include && include[s] === 0)) continue;
    const c = size.length;
    const kv = key[s];
    let head = 0, tail = 0;
    queue[tail++] = s;
    comp[s] = c;
    while (head < tail) {
      const i = queue[head++];
      for (let a = adjOffset[i]; a < adjOffset[i + 1]; a++) {
        const j = adj[a];
        if (comp[j] < 0 && key[j] === kv && !(include && include[j] === 0)) {
          comp[j] = c;
          queue[tail++] = j;
        }
      }
    }
    size.push(tail);
    keys.push(kv);
    first.push(s);
  }
  return { comp, size, key: keys, first };
}
