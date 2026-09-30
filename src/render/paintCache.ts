import { buildMeshGridMap } from '../core/grid';
import type { MeshGridMap, SphereMesh } from '../core/types';

/** Default memory budget of a PaintCache (bytes). */
export const DEFAULT_PAINT_CACHE_BYTES = 192 * 1024 * 1024;

interface Entry {
  value: unknown;
  bytes: number;
}

/**
 * Per-group entry caps (group = key prefix before the first '|'). Per-snapshot intermediates are
 * useless once playback moves on; capping them keeps the byte budget for the static caches (grid
 * maps, detail textures, samplers) and limits garbage-collector pressure.
 */
const GROUP_CAPS: Record<string, number> = {
  height: 4,
  meshterrain: 4,
  rivers: 3,
  drainlines: 3,
  reliefshade: 3,
  enclosed: 3,
  href: 4,
  climsampler: 4,
  satgrid: 26,
  satpix: 2,
  gridmap: 6,
  edgelen: 2,
  detail: 4,
};

/**
 * Expensive static groups (grid maps, detail textures, climate samplers): under byte pressure every
 * other entry is evicted first, in LRU order, so neither snapshot playback nor season playback can
 * push them out. Everything else is plain LRU: the current snapshot's height field / river network
 * (touched by every repaint) outlive stale per-snapshot entries and months not shown for a while.
 * (A "volatile groups first" rule evicted the CURRENT height field while playing seasons at 2048,
 * forcing a height + river rebuild on every month change.)
 */
const PROTECTED_GROUPS = new Set(['gridmap', 'detail', 'climsampler', 'edgelen']);

function groupOf(key: string): string {
  const i = key.indexOf('|');
  return i < 0 ? key : key.slice(0, i);
}

/** Sum of the byteLength of every typed array reachable one level deep in `v` (arrays and plain objects). */
export function estimateBytes(v: unknown): number {
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (Array.isArray(v)) {
    let s = 0;
    for (const x of v) s += estimateBytes(x);
    return s + 16 * v.length;
  }
  if (v && typeof v === 'object') {
    let s = 64;
    for (const x of Object.values(v as Record<string, unknown>)) {
      if (ArrayBuffer.isView(x)) s += x.byteLength;
      else if (Array.isArray(x)) s += estimateBytes(x);
      else s += 8;
    }
    return s;
  }
  return 8;
}

/**
 * Holds reusable, expensive intermediates keyed by VALUE identity (never object identity):
 * `${mesh.n}|${snapshot.id}|${climate?.id}|${w}x${h}|${seed}|${detail}|...` — MeshGridMaps per
 * resolution, smoothed/amplified terrain, static detail textures, climate-derived attribute grids,
 * river networks. One instance per thread. Memory bounded in BYTES (default ≤ 192 MB, LRU).
 * Never retains PaintResult buffers (those are handed to the caller and may be transferred).
 */
export class PaintCache {
  readonly maxBytes: number;
  private readonly entries = new Map<string, Entry>();
  private used = 0;

  constructor(maxBytes: number = DEFAULT_PAINT_CACHE_BYTES) {
    if (!(maxBytes >= 0)) throw new Error(`PaintCache: maxBytes must be ≥ 0 (got ${maxBytes})`);
    this.maxBytes = maxBytes;
  }

  /** Get (building if needed) the MeshGridMap for a mesh at w×h. */
  getGridMap(mesh: SphereMesh, w: number, h: number): MeshGridMap {
    return this.getOrBuild(gridMapKey(mesh.n, w, h), () => buildMeshGridMap(mesh, w, h));
  }

  /** Seed the cache with a map built elsewhere (e.g. transferred from another thread). */
  adoptGridMap(mesh: SphereMesh, map: MeshGridMap): void {
    const npx = map.w * map.h;
    if (map.tri.length !== 3 * npx || map.bary.length !== 3 * npx || map.nearest.length !== npx) {
      throw new Error('PaintCache.adoptGridMap: map arrays do not match its w×h');
    }
    this.set(gridMapKey(mesh.n, map.w, map.h), map);
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }

  /** Bytes currently held. */
  get usedBytes(): number {
    return this.used;
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Cached value (marks it most-recently used) or undefined. */
  get<T>(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value as T;
  }

  /**
   * Store a value. Entries larger than the whole budget are not retained (the caller still uses
   * its value). Evicts least-recently-used entries until the budget holds.
   */
  set<T>(key: string, value: T, bytes: number = estimateBytes(value)): T {
    const old = this.entries.get(key);
    if (old) {
      this.used -= old.bytes;
      this.entries.delete(key);
    }
    if (bytes > this.maxBytes) return value;
    this.entries.set(key, { value, bytes });
    this.used += bytes;
    this.evictGroup(groupOf(key));
    this.evict(key);
    return value;
  }

  getOrBuild<T>(key: string, build: () => T, bytes?: (v: T) => number): T {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const v = build();
    return this.set(key, v, bytes ? bytes(v) : estimateBytes(v));
  }

  /** Drop the least-recently-used members of a group beyond its cap. */
  private evictGroup(group: string): void {
    const cap = GROUP_CAPS[group];
    if (cap === undefined) return;
    let count = 0;
    for (const k of this.entries.keys()) if (groupOf(k) === group) count++;
    if (count <= cap) return;
    for (const [k, e] of this.entries) {
      if (count <= cap) break;
      if (groupOf(k) !== group) continue;
      this.entries.delete(k);
      this.used -= e.bytes;
      count--;
    }
  }

  /**
   * LRU eviction down to the byte budget: unprotected entries first, then everything. The entry
   * just stored (`keep`, ≤ maxBytes) is never evicted by its own insertion.
   */
  private evict(keep: string): void {
    if (this.used <= this.maxBytes) return;
    for (const [k, e] of this.entries) {
      if (this.used <= this.maxBytes) return;
      if (k === keep || PROTECTED_GROUPS.has(groupOf(k))) continue;
      this.entries.delete(k);
      this.used -= e.bytes;
    }
    for (const [k, e] of this.entries) {
      if (this.used <= this.maxBytes) return;
      if (k === keep) continue;
      this.entries.delete(k);
      this.used -= e.bytes;
    }
  }
}

function gridMapKey(n: number, w: number, h: number): string {
  return `gridmap|${n}|${w}x${h}`;
}
