import type { SimMesh } from './simMesh';

/**
 * Multi-source Dijkstra on the world graph (edge = great-circle length, km), restricted to cells
 * whose top plate equals the top plate of the cell the path comes from (i.e. each source spreads
 * only over its own plate). Arrays are sized once; only reached cells are reset between runs.
 */
export class RegionDijkstra {
  /** Distance to the nearest source, km (Infinity when not reached). */
  readonly dist: Float64Array;
  /** Nearest source cell (-1 when not reached). */
  readonly srcOf: Int32Array;
  /** Reached cells in settle order. */
  readonly reached: Int32Array;
  reachedCount = 0;

  constructor(n: number) {
    this.dist = new Float64Array(n).fill(Infinity);
    this.srcOf = new Int32Array(n).fill(-1);
    this.reached = new Int32Array(n);
  }

  reset(): void {
    for (let r = 0; r < this.reachedCount; r++) {
      const c = this.reached[r];
      this.dist[c] = Infinity;
      this.srcOf[c] = -1;
    }
    this.reachedCount = 0;
  }

  /**
   * Run from `count` sources in `sources`, stopping at maxKm. Exact Dijkstra with a bucket queue
   * (Dial's algorithm): with bucket width ≤ the shortest edge, relaxing a settled cell always lands
   * in a later bucket, so cells within one bucket can be settled in any (here: FIFO) order.
   */
  run(sm: SimMesh, top: Int16Array, sources: Int32Array, count: number, maxKm: number): void {
    this.reset();
    const { dist, srcOf, reached } = this;
    const { adjOffset, adj, edgeKm } = sm;
    const width = this.bucketWidth(sm);
    // Bucket index = floor(d / width), evaluated as d · (1 / width) (the same product everywhere; a
    // relaxation still always lands ≥ 1 bucket later since edges exceed the width by a 1e-6 margin).
    const inv = 1 / width;
    const nb = Math.floor(maxKm * inv) + 2;
    this.prepareBuckets(nb);
    const buckets = this.buckets, lens = this.lens;
    let rc = 0;
    for (let q = 0; q < count; q++) {
      const s = sources[q];
      if (dist[s] === 0) continue;
      if (dist[s] === Infinity) reached[rc++] = s;
      dist[s] = 0;
      srcOf[s] = s;
      this.bucketPush(0, s);
    }
    for (let b = 0; b < nb; b++) {
      // Relaxations always land in later buckets (width ≤ shortest edge), so this bucket is final;
      // later buckets may be reallocated by pushes, so they are re-read per entry.
      const cur = buckets[b];
      for (let r = 0; r < lens[b]; r++) {
        const c = cur[r];
        const d = dist[c];
        if (Math.floor(d * inv) !== b) continue; // stale entry: settled from an earlier bucket
        const t = top[c];
        const s = srcOf[c];
        for (let q = adjOffset[c], e = adjOffset[c + 1]; q < e; q++) {
          const a = adj[q];
          if (top[a] !== t) continue;
          const nd = d + edgeKm[q];
          if (nd > maxKm || nd >= dist[a]) continue;
          if (dist[a] === Infinity) reached[rc++] = a;
          dist[a] = nd;
          srcOf[a] = s;
          const bb = Math.floor(nd * inv);
          const len = lens[bb];
          const arr = buckets[bb];
          if (len < arr.length) {
            arr[len] = a;
            lens[bb] = len + 1;
          } else this.bucketPush(bb, a);
        }
      }
    }
    this.reachedCount = rc;
  }

  private width = 0;
  private widthMesh: SimMesh | null = null;
  /** Bucket b holds buckets[b][0 .. lens[b]) (FIFO; arrays grow by doubling and are kept across runs). */
  private buckets: Int32Array[] = [];
  private lens = new Int32Array(0);

  /** Bucket width: slightly less than the shortest edge of the mesh (km). */
  private bucketWidth(sm: SimMesh): number {
    if (this.widthMesh !== sm) {
      let min = Infinity;
      for (let q = 0; q < sm.edgeKm.length; q++) if (sm.edgeKm[q] < min) min = sm.edgeKm[q];
      this.width = min * (1 - 1e-6);
      this.widthMesh = sm;
    }
    return this.width;
  }

  private prepareBuckets(nb: number): void {
    while (this.buckets.length < nb) this.buckets.push(new Int32Array(256));
    if (this.lens.length < nb) this.lens = new Int32Array(nb);
    this.lens.fill(0, 0, nb);
  }

  /** Append cell v to bucket b, growing its array when full. */
  private bucketPush(b: number, v: number): void {
    const len = this.lens[b];
    let arr = this.buckets[b];
    if (len === arr.length) {
      const grown = new Int32Array(2 * arr.length);
      grown.set(arr);
      this.buckets[b] = arr = grown;
    }
    arr[len] = v;
    this.lens[b] = len + 1;
  }
}
