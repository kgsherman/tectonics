import type { SimMesh } from './simMesh';

/**
 * Multi-source Dijkstra on the world graph (edge = great-circle length, km), restricted to cells
 * whose top plate equals the top plate of the cell the path comes from (i.e. each source spreads
 * only over its own plate). Arrays are sized once; only reached cells are reset between runs.
 */
export class RegionDijkstra {
  /** Distance to the nearest source, km (Infinity when not reached). */
  readonly dist: Float32Array;
  /** Nearest source cell (-1 when not reached). */
  readonly srcOf: Int32Array;
  /** Reached cells in settle order. */
  readonly reached: Int32Array;
  reachedCount = 0;
  private heapKey: Float64Array;
  private heapVal: Int32Array;
  private size = 0;

  constructor(n: number) {
    this.dist = new Float32Array(n).fill(Infinity);
    this.srcOf = new Int32Array(n).fill(-1);
    this.reached = new Int32Array(n);
    this.heapKey = new Float64Array(1024);
    this.heapVal = new Int32Array(1024);
  }

  reset(): void {
    for (let r = 0; r < this.reachedCount; r++) {
      const c = this.reached[r];
      this.dist[c] = Infinity;
      this.srcOf[c] = -1;
    }
    this.reachedCount = 0;
    this.size = 0;
  }

  /** Run from `count` sources in `sources`, stopping at maxKm. */
  run(sm: SimMesh, top: Int16Array, sources: Int32Array, count: number, maxKm: number): void {
    this.reset();
    const { dist, srcOf } = this;
    for (let q = 0; q < count; q++) {
      const s = sources[q];
      if (dist[s] === 0) continue;
      if (dist[s] === Infinity) this.reached[this.reachedCount++] = s;
      dist[s] = 0;
      srcOf[s] = s;
      this.push(0, s);
    }
    const { adjOffset, adj, edgeKm } = sm;
    while (this.size > 0) {
      const d = this.heapKey[0];
      const c = this.pop();
      if (d > dist[c]) continue;
      const t = top[c];
      const s = srcOf[c];
      for (let q = adjOffset[c], e = adjOffset[c + 1]; q < e; q++) {
        const a = adj[q];
        if (top[a] !== t) continue;
        const nd = d + edgeKm[q];
        if (nd > maxKm || nd >= dist[a]) continue;
        if (dist[a] === Infinity) this.reached[this.reachedCount++] = a;
        dist[a] = nd;
        srcOf[a] = s;
        this.push(nd, a);
      }
    }
  }

  private push(key: number, val: number): void {
    if (this.size === this.heapKey.length) {
      const k2 = new Float64Array(this.size * 2);
      k2.set(this.heapKey);
      const v2 = new Int32Array(this.size * 2);
      v2.set(this.heapVal);
      this.heapKey = k2;
      this.heapVal = v2;
    }
    const keys = this.heapKey, vals = this.heapVal;
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

  private pop(): number {
    const keys = this.heapKey, vals = this.heapVal;
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
