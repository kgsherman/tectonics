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
    const { dist, srcOf } = this;
    const { adjOffset, adj, edgeKm } = sm;
    const width = this.bucketWidth(sm);
    const nb = Math.floor(maxKm / width) + 2;
    this.prepareBuckets(nb);
    const bHead = this.bHead, bLen = this.bLen;
    for (let q = 0; q < count; q++) {
      const s = sources[q];
      if (dist[s] === 0) continue;
      if (dist[s] === Infinity) this.reached[this.reachedCount++] = s;
      dist[s] = 0;
      srcOf[s] = s;
      this.bucketPush(0, s);
    }
    for (let b = 0; b < nb; b++) {
      // The bucket may grow while it is processed (never: relaxations land in later buckets), but
      // later buckets grow, so re-read their lengths each time.
      for (let r = 0; r < bLen[b]; r++) {
        const c = this.bucketVal[bHead[b] + r];
        const d = dist[c];
        if (Math.floor(d / width) !== b) continue; // stale entry: settled from an earlier bucket
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
          this.bucketPush(Math.floor(nd / width), a);
        }
      }
    }
  }

  private width = 0;
  private widthMesh: SimMesh | null = null;
  /** Bucket storage: bucket b holds bucketVal[bHead[b] .. bHead[b] + bLen[b]) (chunked, see bucketPush). */
  private bucketVal = new Int32Array(0);
  private bHead = new Int32Array(0);
  private bLen = new Int32Array(0);
  private bCap = new Int32Array(0);
  private used = 0;

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
    if (this.bHead.length < nb) {
      this.bHead = new Int32Array(nb);
      this.bLen = new Int32Array(nb);
      this.bCap = new Int32Array(nb);
    }
    this.bHead.fill(-1, 0, nb);
    this.bLen.fill(0, 0, nb);
    this.bCap.fill(0, 0, nb);
    this.used = 0;
    if (this.bucketVal.length === 0) this.bucketVal = new Int32Array(4096);
  }

  /** Append cell v to bucket b (a bucket that outgrows its block moves to a doubled block at the end). */
  private bucketPush(b: number, v: number): void {
    const len = this.bLen[b];
    if (len === this.bCap[b]) {
      const cap = Math.max(64, 2 * len);
      if (this.used + cap > this.bucketVal.length) {
        const grown = new Int32Array(Math.max(2 * this.bucketVal.length, this.used + cap));
        grown.set(this.bucketVal.subarray(0, this.used));
        this.bucketVal = grown;
      }
      const head = this.used;
      if (len > 0) this.bucketVal.copyWithin(head, this.bHead[b], this.bHead[b] + len);
      this.bHead[b] = head;
      this.bCap[b] = cap;
      this.used += cap;
    }
    this.bucketVal[this.bHead[b] + len] = v;
    this.bLen[b] = len + 1;
  }
}
