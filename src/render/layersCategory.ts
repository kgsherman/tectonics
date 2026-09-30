/**
 * Smooth categorical boundaries (plates, crust type) on the display raster.
 *
 * Per mesh cell, the membership of each nearby category is a Gaussian-weighted vote over the cell's
 * two-ring neighbourhood (σ ≈ 1.2 cell spacings): this removes the cell-scale zigzag of the mesh while
 * keeping the boundary where the cells put it. Per pixel, the memberships of the containing triangle's
 * vertices are interpolated barycentrically; the winner k1, runner-up k2 and the margin
 * s = m(k1) − m(k2) define a smooth boundary (s = 0). The margin's pixel-space gradient (signed
 * consistently across the boundary) turns s into a signed distance in pixels for anti-aliased fills
 * and constant-width lines.
 */
import type { MeshGridMap, SphereMesh } from '../core/types';
import type { PaintCache } from './paintCache';

/** Candidate categories kept per cell. */
const K = 3;
/** Gaussian σ of the membership vote, in mesh spacings. */
const SIGMA_SPACINGS = 1.2;
/** Neighbourhood rings of the vote. */
const RINGS = 2;
/** Distance (px) reported for pixels far from any boundary. */
export const FAR_PX = 64;

export interface CellCategories {
  /** K candidate categories per cell, by decreasing membership (−1 = unused). */
  cat: Int32Array;
  memb: Float32Array;
  /** 1 when the whole vote neighbourhood has the cell's own category (membership 1). */
  pure: Uint8Array;
}

/** Static per-mesh vote neighbourhoods: CSR of RINGS-ring neighbours with normalized Gaussian weights. */
interface VoteRings {
  offset: Int32Array;
  idx: Int32Array;
  wgt: Float32Array;
}

const ringMemo = new WeakMap<SphereMesh, VoteRings>();

function voteRings(mesh: SphereMesh): VoteRings {
  let vr = ringMemo.get(mesh);
  if (vr) return vr;
  const { n, adjOffset, adj, xyz } = mesh;
  const inv2s2 = 1 / (2 * (SIGMA_SPACINGS * mesh.spacing) ** 2);
  const stamp = new Int32Array(n).fill(-1);
  const offset = new Int32Array(n + 1);
  let idx = new Int32Array(24 * n);
  let wgt = new Float32Array(24 * n);
  const ring: number[] = [];
  let m = 0;
  for (let i = 0; i < n; i++) {
    // RINGS-ring neighbourhood (breadth first, deduplicated with a stamp).
    ring.length = 0;
    stamp[i] = i;
    ring.push(i);
    let r0 = 0;
    for (let d = 0; d < RINGS; d++) {
      const r1 = ring.length;
      for (let t = r0; t < r1; t++) {
        const j = ring[t];
        for (let q = adjOffset[j]; q < adjOffset[j + 1]; q++) {
          const k = adj[q];
          if (stamp[k] !== i) { stamp[k] = i; ring.push(k); }
        }
      }
      r0 = r1;
    }
    if (m + ring.length > idx.length) {
      const ni = new Int32Array(2 * idx.length);
      ni.set(idx);
      idx = ni;
      const nw = new Float32Array(2 * wgt.length);
      nw.set(wgt);
      wgt = nw;
    }
    const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
    let tot = 0;
    const m0 = m;
    for (let t = 0; t < ring.length; t++) {
      const j = ring[t];
      const dx = xyz[3 * j] - px, dy = xyz[3 * j + 1] - py, dz = xyz[3 * j + 2] - pz;
      const wv = Math.exp(-(dx * dx + dy * dy + dz * dz) * inv2s2);
      idx[m] = j;
      wgt[m++] = wv;
      tot += wv;
    }
    for (let t = m0; t < m; t++) wgt[t] /= tot;
    offset[i + 1] = m;
  }
  vr = { offset, idx: idx.slice(0, m), wgt: wgt.slice(0, m) };
  ringMemo.set(mesh, vr);
  return vr;
}

/**
 * Gaussian RINGS-ring category memberships per cell. `cat` values must be small non-negative ints
 * (plate indices, crust types). The neighbourhoods and weights are static per mesh (memoized), so
 * a new snapshot only pays for the votes of cells near a boundary.
 */
export function cellCategories(mesh: SphereMesh, cat: ArrayLike<number>): CellCategories {
  const { n, adjOffset, adj } = mesh;
  const { offset, idx, wgt } = voteRings(mesh);
  const cc = new Int32Array(K * n).fill(-1);
  const mm = new Float32Array(K * n);
  const pure = new Uint8Array(n);
  // near: the cell or a neighbour touches another category (another category within RINGS rings).
  const edge = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = cat[i];
    for (let q = adjOffset[i]; q < adjOffset[i + 1]; q++) if (cat[adj[q]] !== a) { edge[i] = 1; break; }
  }
  const kc = new Int32Array(16), kw = new Float64Array(16);
  for (let i = 0; i < n; i++) {
    const o = K * i;
    let near = edge[i] === 1;
    if (!near) for (let q = adjOffset[i]; q < adjOffset[i + 1]; q++) if (edge[adj[q]]) { near = true; break; }
    if (!near) {
      cc[o] = cat[i];
      mm[o] = 1;
      pure[i] = 1;
      continue;
    }
    let nk = 0;
    for (let t = offset[i], e = offset[i + 1]; t < e; t++) {
      const k = cat[idx[t]];
      let s = 0;
      while (s < nk && kc[s] !== k) s++;
      if (s === nk) {
        if (nk === 16) continue;
        kc[nk] = k;
        kw[nk++] = 0;
      }
      kw[s] += wgt[t];
    }
    // Top K by weight.
    for (let slot = 0; slot < K; slot++) {
      let b = -1, bw = -1;
      for (let s = 0; s < nk; s++) if (kw[s] > bw) { bw = kw[s]; b = s; }
      if (b < 0 || bw <= 0) break;
      cc[o + slot] = kc[b];
      mm[o + slot] = bw;
      kw[b] = -1;
    }
  }
  return { cat: cc, memb: mm, pure };
}

/** Per-pixel smooth categories: winner, runner-up and signed distance (px) to their boundary. */
export interface PixelCategories {
  k1: Int16Array;
  /** Runner-up category (−1 in pure regions). */
  k2: Int16Array;
  /** Distance (px) from the pixel centre to the k1|k2 boundary, ≥ 0 (FAR_PX when pure). */
  dist: Float32Array;
  /** Pixel-space unit normal of the boundary pointing from k1 toward k2 (x east, y south); only valid
   *  near boundaries, and empty unless requested (`withNormal`). */
  nx: Float32Array;
  ny: Float32Array;
}

/**
 * Small module-level LRU for per-snapshot intermediates (keyed by value, e.g. `plate|${snap.id}`).
 * Kept out of PaintCache on purpose: playback creates a new snapshot every frame, and a bounded
 * entry count keeps per-snapshot data from accumulating in the shared byte budget.
 */
const SNAP_MEMO_MAX = 6;
const snapMemo = new Map<string, unknown>();
export function snapshotMemo<T>(key: string, build: () => T): T {
  const hit = snapMemo.get(key);
  if (hit !== undefined) {
    snapMemo.delete(key);
    snapMemo.set(key, hit);
    return hit as T;
  }
  const v = build();
  snapMemo.set(key, v);
  while (snapMemo.size > SNAP_MEMO_MAX) snapMemo.delete(snapMemo.keys().next().value as string);
  return v;
}

/** Per-cell memberships for a category array identified by `key` (e.g. `plate|${snapshot.id}`), memoized. */
export function getCellCategories(mesh: SphereMesh, cat: ArrayLike<number>, key: string, _cache?: PaintCache): CellCategories {
  return snapshotMemo(`cellcat|${mesh.n}|${key}`, () => cellCategories(mesh, cat));
}

const EMPTY = new Float32Array(0);

// Scratch pools: the per-pixel arrays live only during one paint call (painting is synchronous).
const pool16: Int16Array[] = [];
const pool32: Float32Array[] = [];
function i16(slot: number, n: number): Int16Array {
  if (!pool16[slot] || pool16[slot].length !== n) pool16[slot] = new Int16Array(n);
  return pool16[slot];
}
function f32(slot: number, n: number): Float32Array {
  if (!pool32[slot] || pool32[slot].length !== n) pool32[slot] = new Float32Array(n);
  return pool32[slot];
}

/**
 * The last result and its inputs (weakly held: the grid map belongs to a PaintCache that may evict
 * it). A playback frame of the plates layer resolves the same (map, memberships) again for the
 * boundary overlay; the second call returns the pooled arrays as they are.
 */
let lastMap: WeakRef<MeshGridMap> | null = null;
let lastCC: WeakRef<CellCategories> | null = null;
let lastRes: PixelCategories | null = null;

/**
 * Resolve the smooth categories on the raster of `map` (categories must fit in Int16). The result
 * uses shared scratch buffers: it is valid until the next call with different inputs (a repeated
 * call with the same map and memberships object returns it unchanged; callers must not write to
 * it). When `withNormal` is false the normal arrays are not written.
 */
export function pixelCategories(map: MeshGridMap, cc: CellCategories, withNormal = false): PixelCategories {
  if (lastRes && (lastRes.nx.length > 0 || !withNormal) && lastMap?.deref() === map && lastCC?.deref() === cc) return lastRes;
  // The pools are about to be overwritten: forget the previous result first.
  lastRes = null;
  const res = resolvePixelCategories(map, cc, withNormal);
  lastMap = new WeakRef(map);
  lastCC = new WeakRef(cc);
  lastRes = res;
  return res;
}

function resolvePixelCategories(map: MeshGridMap, cc: CellCategories, withNormal: boolean): PixelCategories {
  const { w, h, tri, bary, nearest } = map;
  const npx = w * h;
  const k1 = i16(0, npx), k2 = i16(1, npx);
  const s = f32(0, npx);
  const { cat, memb, pure } = cc;
  const cand = new Int32Array(9), candM = new Float64Array(9);
  for (let p = 0, t = 0; p < npx; p++, t += 3) {
    // Fast path: the nearest cell has no other category within two rings, so the boundary is
    // ≥ ~1.5 cell spacings away (far beyond any line or anti-aliasing width).
    const vn = nearest[p];
    if (pure[vn]) {
      k1[p] = cat[K * vn];
      k2[p] = -1;
      s[p] = 1;
      continue;
    }
    const va = tri[t], vb = tri[t + 1], vc = tri[t + 2];
    const ka = cat[K * va];
    const wa = bary[t], wb = bary[t + 1], wc = bary[t + 2];
    if (cat[K * vb] === ka && cat[K * vc] === ka) {
      // One leading category at all three vertices: when its interpolated membership is high the
      // boundary is far (s ≥ 0.8, ≥ ~1.5 spacings) — keep the margin estimate for the gradient of
      // nearby boundary pixels and skip the candidate search.
      const m = wa * memb[K * va] + wb * memb[K * vb] + wc * memb[K * vc];
      if (m >= 0.9) {
        k1[p] = ka;
        k2[p] = -1;
        s[p] = 2 * m - 1;
        continue;
      }
    }
    // Interpolated membership of every candidate category (absent from a vertex's list = 0).
    let nc = 0;
    for (let q = 0; q < 3; q++) {
      const v = q === 0 ? va : q === 1 ? vb : vc;
      const wq = q === 0 ? wa : q === 1 ? wb : wc;
      for (let e = K * v, end = e + K; e < end; e++) {
        const k = cat[e];
        if (k === -1) break;
        const mv = wq * memb[e];
        let z = 0;
        while (z < nc && cand[z] !== k) z++;
        if (z === nc) { cand[nc] = k; candM[nc++] = mv; } else candM[z] += mv;
      }
    }
    let b1 = -1, m1 = -1, b2 = -1, m2 = -1;
    for (let z = 0; z < nc; z++) {
      const m = candM[z];
      if (m > m1) { b2 = b1; m2 = m1; b1 = cand[z]; m1 = m; } else if (m > m2) { b2 = cand[z]; m2 = m; }
    }
    k1[p] = b1;
    k2[p] = b2;
    s[p] = b2 === -1 ? 1 : m1 - m2;
  }
  // Signed distance: central differences of the margin, taking neighbours won by another category
  // as lying on the far side of the boundary (negative margin).
  const dist = f32(1, npx).fill(FAR_PX);
  const nx = withNormal ? f32(2, npx) : EMPTY, ny = withNormal ? f32(3, npx) : EMPTY;
  for (let r = 0; r < h; r++) {
    const row = r * w;
    const rowN = (r > 0 ? r - 1 : 0) * w, rowS = (r < h - 1 ? r + 1 : h - 1) * w;
    for (let c = 0; c < w; c++) {
      const p = row + c;
      if (k2[p] === -1) continue;
      const k = k1[p];
      const pl = row + (c > 0 ? c - 1 : w - 1), pr = row + (c + 1 < w ? c + 1 : 0), pn = rowN + c, ps = rowS + c;
      const vl = k1[pl] === k ? s[pl] : -s[pl];
      const vr = k1[pr] === k ? s[pr] : -s[pr];
      const vn = k1[pn] === k ? s[pn] : -s[pn];
      const vs = k1[ps] === k ? s[ps] : -s[ps];
      const gx = 0.5 * (vr - vl), gy = 0.5 * (vs - vn);
      const g = Math.sqrt(gx * gx + gy * gy);
      if (g < 1e-6) continue;
      const d = s[p] / g;
      dist[p] = d < FAR_PX ? d : FAR_PX;
      if (withNormal) {
        // s decreases toward k2.
        nx[p] = -gx / g;
        ny[p] = -gy / g;
      }
    }
  }
  return { k1, k2, dist, nx, ny };
}
