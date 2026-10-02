/**
 * Translucent static clouds for the 2D map: the globe's weather model (coverage-driven, domain-warped
 * multi-octave noise, regimes, cirrus, anvils, storm-track cyclones) rasterized by cloudsRaster.ts
 * into an equirect canvas that the map draws stretched.
 *
 * The raster is computed by the cloud worker (the climate-independent noise once, then one pass per
 * cloud spec) and arrives as an ImageBitmap, so set() costs the main thread nothing; `onUpdate` is
 * called when the new clouds are in the canvas (the map must redraw then). Without an `onUpdate`
 * listener (a host that cannot redraw later) set() falls back to rasterizing synchronously at a
 * lower resolution.
 *
 * Quality (CloudSpec.quality): 'high' as described here; 'standard' rasterizes a half-size world
 * raster and no tiles (cheap enough to follow every month / climate change).
 *
 * Tiles ('high' quality): the world raster is ~1536 px wide, so at 8× it would be stretched ~8 px per
 * texel (blurry), and it resolves only two detail octaves. A host that reports its view (setView)
 * and draws the layer through drawCopy() gets tiles over it: a quadtree pyramid of MAP_CLOUD_TILE_PX²
 * equirect tiles (level L: π/2^L radians a side) with every detail octave their resolution resolves.
 * The visible tiles of the level matching the screen resolution (at any zoom: at least one level
 * finer than the world raster) are computed in the worker, nearest the view centre first, once the
 * view settles; then, optimistically, the next finer level under the view and the next coarser one
 * around it, so zooming in or out (slowly) crosses each level's breakpoint onto tiles already made.
 * Tiles are cached (LRU) for the clouds on screen. Every part of the view shows its own level only:
 * the picture changes at zoom breakpoints, not when a prefetched tile lands (other cached levels stand
 * in, coarse to fine, only where the view's own tile is not there yet). Zooming or panning back is
 * instant.
 */
import type { CloudQuality, CloudSpec } from '../core/types';
import type { CloudRasterResult } from './cloudsJobs';
import { buildCloudNoiseRaster, rasterizeClouds, rasterOctaveLevel, type CloudNoiseRaster, type CloudRasterStats, type CloudRasterWindow } from './cloudsRaster';
import { context2d } from './mapCanvas';
import type { MapTransform } from './viewMapTransform';
import { cloudWorker } from './cloudsWorkerClient';

/**
 * Raster size: about a screen's width at map zoom 1 (the second detail octave is ~1.9 px per cell;
 * ~0.3 s per cloud spec in the worker, ~0.3 s once for the static noise).
 */
const CW = 1536;
const CH = 768;
/**
 * Standard-quality raster (CloudQuality): half the size (~4× cheaper, ~60 ms per cloud spec), drawn
 * stretched into the same canvas; standard clouds get no tiles when zoomed in.
 */
const STANDARD_W = 768;
const STANDARD_H = 384;
/**
 * Synchronous fallback raster size (no onUpdate listener: the host cannot redraw later), about the
 * cost of the old synchronous path (tens of ms per spec).
 */
const SYNC_W = 768;
const SYNC_H = 384;
/** Default opacity on the map: a lighter veil than the globe so the terrain stays readable. */
export const MAP_CLOUD_OPACITY = 0.8;
/** Tile edge in raster pixels (~60 ms in the worker), plus a 1-px apron on every side (seamless relief shading). */
export const MAP_CLOUD_TILE_PX = 256;
const APRON = 1;
/** Finest tile level (π/512 rad tiles, ~21 000 px per radian: zoom 48 at DPR 1.5 on a 2500 px map). */
export const MAP_CLOUD_MAX_LEVEL = 9;
/** Pixel budget of the tiles one view needs (~50 tiles); beyond it the view takes the next coarser level. */
const VIEW_BUDGET_PX = 3.3e6;
/** Tiles kept (least recently drawn evicted first; ~260 KB each): a view, its prefetch and a few views back. */
const MAX_TILES = 320;
/** Most tiles prefetched at the next finer level (4× the view's: beyond it, no finer prefetch). */
const PREFETCH_MAX = 200;
/** Stand-in tiles finer than this many times the screen resolution are not drawn (sub-pixel detail: cost only). */
const MAX_DOWNSCALE = 4;
/** Coarsest stand-in drawn: this many levels above the view's. */
const FALLBACK_COARSER = 3;
/** Tiles may have this share of the screen resolution (slightly magnified: one level less work). */
const RES_ENOUGH = 0.85;
/** The view must rest this long before tiles are requested (ms; zoom animations pass through levels). */
const DETAIL_SETTLE_MS = 220;

/** Raster pixels per radian of tiles at `level`. */
export function mapCloudTileRes(level: number): number {
  return (MAP_CLOUD_TILE_PX * 2 ** level) / Math.PI;
}

/**
 * Tile level for a screen resolution `need` (pixels per radian) when the world raster has `worldRes`:
 * the coarsest level with at least RES_ENOUGH of `need`, and finer than the world raster (zoomed out
 * too: the whole view is tiled, every part of it at the same quality, the world raster only a
 * placeholder until its tiles land).
 */
export function mapCloudTileLevel(need: number, worldRes: number): number {
  let min = 1;
  while (min < MAP_CLOUD_MAX_LEVEL && mapCloudTileRes(min) <= worldRes) min++;
  const l = need > 0 ? Math.ceil(Math.log2((RES_ENOUGH * need * Math.PI) / MAP_CLOUD_TILE_PX) - 1e-9) : min;
  return Math.min(MAP_CLOUD_MAX_LEVEL, Math.max(min, l));
}

/** The geographic window of tile (level, x, y) (x from −180° eastward, y from the north pole), without its apron. */
export function mapCloudTileWindow(level: number, x: number, y: number): CloudRasterWindow {
  const s = Math.PI / 2 ** level;
  return { lon0: -Math.PI + x * s, lon1: -Math.PI + (x + 1) * s, lat0: Math.PI / 2 - (y + 1) * s, lat1: Math.PI / 2 - y * s };
}

let syncRaster: CloudNoiseRaster | null = null;
let instances = 0;

/** A cached tile. */
interface Tile {
  level: number;
  x: number;
  y: number;
  /** Spec sequence it was rasterized for. */
  specSeq: number;
  /** The raster, MAP_CLOUD_TILE_PX + 2·APRON square: the worker's bitmap, or a canvas. */
  image: ImageBitmap | HTMLCanvasElement;
  /** Frame stamp (setView calls) when it was last drawn or made (LRU). */
  used: number;
}

/** What the view needs: the tile level (0: the world raster suffices) and its visible tiles. */
interface TileView {
  level: number;
  /** Visible tile index ranges at `level` (x unwrapped: may leave [0, 2^(level+1)); y within [0, 2^level)). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** View centre in tile units (priority: nearest first). */
  cx: number;
  cy: number;
  /** Screen resolution (raster pixels per radian) and the viewport (CSS px). */
  need: number;
  width: number;
  height: number;
  key: string;
}

const tileKey = (level: number, x: number, y: number): string => `${level}/${x}/${y}`;

export class MapClouds {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  active = false;
  /** Statistics of the last rasterization (area-weighted). */
  stats: CloudRasterStats | null = null;
  /** Called when new clouds landed in `canvas` or a visible tile landed (asynchronously after set() / setView()). */
  onUpdate: (() => void) | null;
  /** Worker compute time of the last world raster (ms, diagnostics). */
  lastJobMs = 0;
  /** Worker compute time of the last tile (ms, diagnostics). */
  lastDetailMs = 0;
  /** Quality of the world raster on screen (null: none). */
  shownQuality: CloudQuality | null = null;
  /** Called with the spec given to set() once its world raster is on screen. */
  onShown: ((clouds: CloudSpec) => void) | null = null;
  /** Size of the world raster on screen (its result, drawn stretched into `canvas`). */
  private worldSize: { w: number; h: number } | null = null;
  private readonly channel = `map-clouds-${++instances}`;
  private readonly tileChannel = `${this.channel}-tiles`;
  private seq = 0;
  private clearedAt = 0;
  private jobs = 0;
  /** Last cloud spec and opacity (tiles are made from them). */
  private spec: CloudSpec | null = null;
  private opacity = MAP_CLOUD_OPACITY;
  /** Sequence of the last set() spec (new tiles are made for it). */
  private specSeq = 0;
  /** Sequence of the spec whose world raster is on screen (the tiles drawn are its own). */
  private worldSeq = -1;
  private readonly tiles = new Map<string, Tile>();
  /** The tile in the worker (one at a time: the next is chosen for the view as it is then). */
  private tileJob: { level: number; x: number; y: number; specSeq: number } | null = null;
  private view: TileView | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Frame stamp for the tile LRU (counts setView calls). */
  private frame = 0;

  constructor(onUpdate: (() => void) | null = null) {
    this.onUpdate = onUpdate;
    this.canvas = document.createElement('canvas');
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.ctx = context2d(this.canvas);
  }

  /** A raster or tile is being computed, or tiles wait for the view to settle. */
  get pending(): boolean {
    return this.jobs > 0 || this.tileJob !== null || this.timer !== null;
  }

  get busy(): boolean {
    return this.jobs > 0 || this.tileJob !== null;
  }

  /** Tiles in the cache (diagnostics / tests). */
  get tileCount(): number {
    return this.tiles.size;
  }

  set(clouds: CloudSpec | null, opacity = MAP_CLOUD_OPACITY): void {
    const seq = ++this.seq;
    this.active = clouds !== null;
    if (!clouds) {
      this.clearedAt = seq;
      cloudWorker().cancel(this.channel);
      this.spec = null;
      this.shownQuality = null;
      this.worldSize = null;
      this.stopTiles();
      return;
    }
    if (!(clouds.w > 0 && clouds.h > 0) || clouds.cover.length < clouds.w * clouds.h) {
      throw new Error(`MapClouds: cover does not match ${clouds.w}x${clouds.h}`);
    }
    if (!this.onUpdate) {
      this.setSync(clouds, opacity);
      this.shownQuality = clouds.quality ?? 'high';
      this.onShown?.(clouds);
      return;
    }
    const quality = clouds.quality ?? 'high';
    const high = quality === 'high';
    const n = clouds.w * clouds.h;
    const spec: CloudSpec = { w: clouds.w, h: clouds.h, cover: clouds.cover.slice(0, n), quality };
    if (clouds.u && clouds.v && clouds.u.length >= n && clouds.v.length >= n) {
      spec.u = clouds.u.slice(0, n);
      spec.v = clouds.v.slice(0, n);
    }
    this.spec = spec;
    this.opacity = opacity;
    this.specSeq = seq;
    this.jobs++;
    const [rw, rh] = high ? [CW, CH] : [STANDARD_W, STANDARD_H];
    void cloudWorker().run({ kind: 'raster', spec, w: rw, h: rh, opacity, time: 0 }, this.channel).then((res) => {
      this.jobs--;
      if (!res) return;
      if (seq < this.clearedAt) {
        res.bitmap?.close(); // dropped: free its backing store now, not at GC
        return;
      }
      this.paint(this.ctx, this.canvas, res);
      this.worldSize = { w: res.w, h: res.h };
      this.lastJobMs = res.ms;
      this.stats = res.stats;
      this.shownQuality = quality;
      // The tiles drawn are those of the clouds now on screen: older ones are freed.
      this.worldSeq = seq;
      for (const [k, t] of this.tiles) if (t.specSeq < seq) this.freeTile(k, t);
      this.onUpdate?.();
      this.onShown?.(clouds);
    });
    if (!high) {
      // Standard clouds: no tiles (the world raster alone, also when zoomed in).
      this.stopTiles();
      return;
    }
    // Tiles of the new clouds for the view on screen (after the world raster: the worker runs jobs in
    // order). The previous clouds' tiles stay drawn, over their world raster, until it is replaced.
    this.pump();
  }

  /**
   * The host's current map transform (CSS px) and device pixel ratio; cheap, call it on every redraw.
   * The visible tiles of the level matching the screen resolution (mapCloudTileLevel) are requested
   * once the view has rested DETAIL_SETTLE_MS (those not cached yet, nor covered by finer cached ones).
   */
  setView(t: MapTransform, dpr = 1): void {
    this.frame++;
    if (!this.active || !this.spec || !this.onUpdate || this.spec.quality === 'standard') return;
    // A hidden / zero-size map has no view (its tile ranges would be NaN).
    if (!(t.width > 0 && t.height > 0 && t.scale > 0 && Number.isFinite(t.centerLon) && Number.isFinite(t.centerLat))) {
      this.view = null;
      this.clearTimer();
      return;
    }
    // Screen resolution: device pixels, at most 1.5 per CSS px (sharper is not worth the work).
    const need = t.scale * Math.min(1.5, Math.max(1, dpr));
    const worldRes = this.worldRes();
    let level = mapCloudTileLevel(need, worldRes);
    let r = tileRange(t, level);
    // Within the pixel budget (huge, wide views take the next coarser level), finer than the world raster.
    while (level > 0 && (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) * (MAP_CLOUD_TILE_PX + 2 * APRON) ** 2 > VIEW_BUDGET_PX) {
      level--;
      if (mapCloudTileRes(level) <= worldRes) level = 0;
      r = tileRange(t, level);
    }
    const key = level > 0 ? `${level}:${r.x0}:${r.x1}:${r.y0}:${r.y1}` : '0';
    const changed = key !== this.view?.key;
    this.view = { level, ...r, need, width: t.width, height: t.height, key };
    if (level === 0) {
      this.clearTimer();
      return;
    }
    if (changed) {
      // A new set of tiles: wait for the view to rest (zoom animations pass through levels).
      this.clearTimer();
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, DETAIL_SETTLE_MS);
      return;
    }
    this.pump();
  }

  /**
   * Draws the clouds into world copy rectangle (x, y, w, h) (the equirect world at the host's
   * transform, in the context's current units): the world raster stretched, then the tiles of the
   * view's level. Where one of those is not there yet, cached tiles of other levels stand in, coarse
   * to fine (coarser ones stretched, finer ones downscaled), so a tile landing for another level
   * (prefetch) never changes the picture.
   */
  drawCopy(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    ctx.drawImage(this.canvas, x, y, w, h);
    const v = this.view;
    if (!v || v.level === 0 || this.tiles.size === 0) return;
    const seq = this.worldSeq, L = v.level;
    const maxLevel = Math.max(L, drawLevel(v.need)), minLevel = Math.max(1, L - FALLBACK_COARSER);
    // Tile edges snapped to device pixels (axis-aligned transforms): neighbours meet exactly instead of
    // both covering the boundary pixel partly (a hairline seam).
    const tf = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const m = tf !== null && tf.b === 0 && tf.c === 0 && tf.a > 0 && tf.d > 0 ? tf : null;
    const sx = (val: number): number => (m ? (Math.round(m.a * val + m.e) - m.e) / m.a : val);
    const sy = (val: number): number => (m ? (Math.round(m.d * val + m.f) - m.f) / m.d : val);
    const list: [Tile, number, number, number, number][] = [];
    for (const tile of this.tiles.values()) {
      if (tile.specSeq !== seq || tile.level < minLevel || tile.level > maxLevel) continue;
      const n = 2 ** tile.level;
      const l = x + (tile.x / (2 * n)) * w, r = x + ((tile.x + 1) / (2 * n)) * w;
      const tp = y + (tile.y / n) * h, b = y + ((tile.y + 1) / n) * h;
      if (r <= 0 || l >= v.width || b <= 0 || tp >= v.height) continue;
      if (tile.level < L) {
        // Coarser stand-in: only where some of the view-level tiles inside it (on screen) are missing.
        if (!this.missingOnScreen(tile, L, seq, x, y, w, h, v)) continue;
      } else if (tile.level > L) {
        // Finer stand-in: only where its view-level tile is missing.
        const d = tile.level - L;
        if (this.tiles.get(tileKey(L, tile.x >> d, tile.y >> d))?.specSeq === seq) continue;
      }
      list.push([tile, sx(l), sy(tp), sx(r), sy(b)]);
    }
    list.sort((a, b) => a[0].level - b[0].level);
    for (const [tile, l, tp, r, b] of list) {
      tile.used = this.frame;
      ctx.drawImage(tile.image, APRON, APRON, MAP_CLOUD_TILE_PX, MAP_CLOUD_TILE_PX, l, tp, r - l, b - tp);
    }
  }

  /**
   * Debug view (?cloudDebug, cloudsDebug.ts): labels tiles (1–90°, by zoom) of the visible map (CSS px transform
   * `t`) with the raster each is drawn from — W(orld) or the finest drawn tile Tn (level n) — its size,
   * its effective detail octaves (0–4) and how much it is stretched on screen (×1 = one raster pixel
   * per screen pixel), coloured by octaves (red ≤ 2, yellow 3, green 4).
   */
  drawDebug(ctx: CanvasRenderingContext2D, t: MapTransform): void {
    const world = this.worldSize;
    if (!this.active || !world || !(t.scale > 0)) return;
    const sx = (lon: number): number => t.width / 2 + (lon - t.centerLon) * t.scale;
    const sy = (lat: number): number => t.height / 2 - (lat - t.centerLat) * t.scale;
    const maxLevel = this.view ? Math.max(this.view.level, drawLevel(this.view.need)) : 0;
    const worldRes = this.worldRes();
    /** Tile level drawn at a point: the view's own, else the finest stand-in (0: the world raster). */
    const levelAt = (lon: number, lat: number): number => {
      const own = this.view?.level ?? 0;
      if (own > 0) {
        const s = Math.PI / 2 ** own, n = 2 ** (own + 1);
        const tx = ((Math.floor((lon + Math.PI) / s) % n) + n) % n, ty = Math.min(2 ** own - 1, Math.floor((Math.PI / 2 - lat) / s));
        if (this.tiles.get(tileKey(own, tx, ty))?.specSeq === this.worldSeq) return own;
      }
      for (let L = maxLevel; L >= 1 && mapCloudTileRes(L) > worldRes; L--) {
        const s = Math.PI / 2 ** L, n = 2 ** (L + 1);
        const tx = ((Math.floor((lon + Math.PI) / s) % n) + n) % n, ty = Math.min(2 ** L - 1, Math.floor((Math.PI / 2 - lat) / s));
        if (this.tiles.get(tileKey(L, tx, ty))?.specSeq === this.worldSeq) return L;
      }
      return 0;
    };
    ctx.save();
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Labels at least ~110 CSS px apart (they are 92 px wide): 1° … 90° by zoom.
    const step = ([1, 2.5, 5, 10, 15, 30, 45, 90].find((deg) => deg * (Math.PI / 180) * t.scale >= 110) ?? 90) * (Math.PI / 180);
    const halfW = t.width / 2 / t.scale, halfH = t.height / 2 / t.scale;
    const lonA = Math.floor((t.centerLon - halfW) / step) * step, lonB = t.centerLon + halfW;
    const latA = Math.max(-Math.PI / 2, Math.floor((t.centerLat - halfH) / step) * step), latB = Math.min(Math.PI / 2, t.centerLat + halfH);
    for (let lat = latA; lat < latB; lat += step) {
      for (let lon = lonA; lon < lonB; lon += step) {
        const clon = lon + step / 2, clat = lat + step / 2;
        if (clat > Math.PI / 2) continue;
        const L = levelAt(clon, clat);
        const px = L > 0 ? Math.PI / 2 ** L / MAP_CLOUD_TILE_PX : Math.PI / world.h;
        const level = rasterOctaveLevel(px);
        const stretch = t.scale * px;
        const x = sx(clon), y = sy(clat);
        const lines = [L > 0 ? `T${L} ${MAP_CLOUD_TILE_PX}²` : `W ${world.w}×${world.h}`, `${level.toFixed(1)} oct ×${stretch.toFixed(1)}`];
        const bw = 92, bh = 30;
        ctx.fillStyle = level < 2.5 ? 'rgba(200, 40, 30, 0.75)' : level < 3.5 ? 'rgba(190, 150, 20, 0.75)' : 'rgba(30, 150, 60, 0.75)';
        ctx.fillRect(x - bw / 2, y - bh / 2, bw, bh);
        ctx.fillStyle = '#fff';
        ctx.fillText(lines[0], x, y - 7);
        ctx.fillText(lines[1], x, y + 7);
      }
    }
    ctx.restore();
  }

  /** Stops pending tile work and releases the rasters (late results are dropped). */
  dispose(): void {
    this.clearedAt = ++this.seq;
    this.onUpdate = null;
    this.onShown = null;
    cloudWorker().cancel(this.channel);
    this.stopTiles();
    this.spec = null;
    this.active = false;
    this.canvas.width = this.canvas.height = 0;
  }

  /**
   * Some level-L tile inside the coarser `tile` is on screen (world copy x, y, w, h; viewport of `v`)
   * and missing for spec `seq`.
   */
  private missingOnScreen(tile: Tile, L: number, seq: number, x: number, y: number, w: number, h: number, v: TileView): boolean {
    const k = 2 ** (L - tile.level), n = 2 ** L;
    for (let j = 0; j < k; j++) {
      const cy = tile.y * k + j;
      if (y + ((cy + 1) / n) * h <= 0 || y + (cy / n) * h >= v.height) continue;
      for (let i = 0; i < k; i++) {
        const cx = tile.x * k + i;
        if (x + ((cx + 1) / (2 * n)) * w <= 0 || x + (cx / (2 * n)) * w >= v.width) continue;
        if (this.tiles.get(tileKey(L, cx, cy))?.specSeq !== seq) return true;
      }
    }
    return false;
  }

  /** Raster pixels per radian of the world raster on screen. */
  private worldRes(): number {
    return (this.worldSize?.w ?? CW) / (2 * Math.PI);
  }

  /**
   * The count × count tiles from (level, x, y) (x wrapped here) are all there for spec `seq`, each
   * itself or (depth > 0) through its four children, at levels up to maxLevel.
   */
  private covered(level: number, x: number, y: number, seq: number, maxLevel: number, depth: number, count = 1): boolean {
    if (level > maxLevel) return false;
    const n = 2 ** (level + 1);
    for (let j = 0; j < count; j++) {
      for (let i = 0; i < count; i++) {
        const tx = (((x + i) % n) + n) % n, ty = y + j;
        if (this.tiles.get(tileKey(level, tx, ty))?.specSeq === seq) continue;
        if (depth > 0 && this.covered(level + 1, 2 * tx, 2 * ty, seq, maxLevel, depth - 1, 2)) continue;
        return false;
      }
    }
    return true;
  }

  /**
   * Requests the next tile, one at a time (each landing picks the next for the view as it is then):
   * the view's own level, then the next finer level under the view (zooming in), then the next coarser
   * one (zooming out); nearest the view centre first.
   */
  private pump(): void {
    if (this.tileJob || this.timer !== null) return;
    const spec = this.spec, v = this.view;
    if (!spec || !v || v.level === 0 || spec.quality === 'standard' || !this.onUpdate) return;
    const next = this.nextTile(v);
    if (!next) return;
    const job = { ...next, specSeq: this.specSeq };
    this.tileJob = job;
    const core = mapCloudTileWindow(job.level, job.x, job.y);
    const a = (APRON * (core.lat1 - core.lat0)) / MAP_CLOUD_TILE_PX;
    const win: CloudRasterWindow = { lon0: core.lon0 - a, lon1: core.lon1 + a, lat0: core.lat0 - a, lat1: core.lat1 + a };
    const size = MAP_CLOUD_TILE_PX + 2 * APRON;
    const cleared = this.clearedAt;
    void cloudWorker().run(
      { kind: 'raster', spec, w: size, h: size, opacity: this.opacity, time: 0, win, specKey: `${this.channel}:${job.specSeq}` }, this.tileChannel,
    ).then((r) => {
      if (this.tileJob === job) this.tileJob = null;
      if (!r) return;
      if (this.clearedAt !== cleared || job.specSeq !== this.specSeq || this.spec?.quality !== 'high') {
        r.bitmap?.close(); // stale: free its backing store now
        this.pump();
        return;
      }
      let image: ImageBitmap | HTMLCanvasElement;
      if (r.bitmap) {
        image = r.bitmap;
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = r.w;
        canvas.height = r.h;
        this.paint(context2d(canvas), canvas, r);
        image = canvas;
      }
      const k = tileKey(job.level, job.x, job.y);
      const old = this.tiles.get(k);
      if (old) this.freeTile(k, old);
      this.tiles.set(k, { ...job, image, used: this.frame });
      this.evict();
      this.lastDetailMs = r.ms;
      if (job.specSeq === this.worldSeq) this.onUpdate?.();
      this.pump();
    });
  }

  /** The next missing tile for view `v` (see pump), or null when the view and its prefetch are complete. */
  private nextTile(v: TileView): { level: number; x: number; y: number } | null {
    const levels = [v.level];
    if (v.level < MAP_CLOUD_MAX_LEVEL && 4 * (v.x1 - v.x0 + 1) * (v.y1 - v.y0 + 1) <= PREFETCH_MAX) levels.push(v.level + 1);
    if (v.level - 1 >= mapCloudTileLevel(0, this.worldRes())) levels.push(v.level - 1);
    for (const L of levels) {
      // The view's tile ranges at level L: finer, its children (zooming in shrinks the view); coarser,
      // twice its extent about its centre (zooming out widens it; as many tiles as the view's own).
      const f = 2 ** (L - v.level), rows = 2 ** L, n = 2 * rows;
      const cx = v.cx * f, cy = v.cy * f, grow = L < v.level ? 2 : 1;
      const hx = ((v.x1 + 1 - v.x0) / 2) * f * grow, hy = ((v.y1 + 1 - v.y0) / 2) * f * grow;
      const x0 = Math.floor(grow > 1 ? cx - hx : v.x0 * f);
      const x1 = Math.min((grow > 1 ? Math.ceil(cx + hx) : Math.ceil((v.x1 + 1) * f)) - 1, x0 + n - 1);
      const y0 = Math.max(0, Math.floor(grow > 1 ? cy - hy : v.y0 * f));
      const y1 = Math.min(rows - 1, (grow > 1 ? Math.ceil(cy + hy) : Math.ceil((v.y1 + 1) * f)) - 1);
      let best: [number, number] | null = null, bestD = Infinity;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
          if (d >= bestD) continue;
          const tx = ((x % n) + n) % n;
          if (this.tiles.get(tileKey(L, tx, y))?.specSeq === this.specSeq) continue;
          best = [tx, y];
          bestD = d;
        }
      }
      if (best) return { level: L, x: best[0], y: best[1] };
    }
    return null;
  }

  /** Least recently drawn tiles freed down to MAX_TILES. */
  private evict(): void {
    if (this.tiles.size <= MAX_TILES) return;
    const byAge = [...this.tiles.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < byAge.length && this.tiles.size > MAX_TILES; i++) this.freeTile(byAge[i][0], byAge[i][1]);
  }

  private freeTile(k: string, t: Tile): void {
    this.tiles.delete(k);
    if ('close' in t.image) t.image.close();
    else t.image.width = t.image.height = 0;
  }

  /** No tiles: pending work cancelled (an in-flight tile is dropped when it lands), the cache freed. */
  private stopTiles(): void {
    cloudWorker().cancel(this.tileChannel);
    this.tileJob = null;
    this.clearTimer();
    this.view = null;
    for (const [k, t] of this.tiles) this.freeTile(k, t);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private paint(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, res: CloudRasterResult): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (res.bitmap) {
      ctx.drawImage(res.bitmap, 0, 0, canvas.width, canvas.height);
      res.bitmap.close();
    } else {
      const img = new ImageData(res.rgba as Uint8ClampedArray<ArrayBuffer>, res.w, res.h);
      if (res.w === canvas.width && res.h === canvas.height) {
        ctx.putImageData(img, 0, 0);
      } else {
        const tmp = document.createElement('canvas');
        tmp.width = res.w;
        tmp.height = res.h;
        context2d(tmp).putImageData(img, 0, 0);
        ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
      }
    }
  }

  private setSync(clouds: CloudSpec, opacity: number): void {
    syncRaster ??= buildCloudNoiseRaster(SYNC_W, SYNC_H);
    const rgba = new Uint8ClampedArray(SYNC_W * SYNC_H * 4);
    this.stats = rasterizeClouds(syncRaster, clouds, opacity, rgba);
    this.paint(this.ctx, this.canvas, { kind: 'raster', w: SYNC_W, h: SYNC_H, rgba, stats: this.stats, ms: 0 });
    this.worldSize = { w: SYNC_W, h: SYNC_H };
  }
}

/** Finest tile level drawn for screen resolution `need` (at most MAX_DOWNSCALE× finer than the screen). */
function drawLevel(need: number): number {
  let l = 0;
  while (l < MAP_CLOUD_MAX_LEVEL && mapCloudTileRes(l + 1) <= MAX_DOWNSCALE * need) l++;
  return l;
}

/** Visible tile index ranges at `level` for transform `t` (empty at level 0) and the view centre in tile units. */
function tileRange(t: MapTransform, level: number): { x0: number; x1: number; y0: number; y1: number; cx: number; cy: number } {
  if (level === 0) return { x0: 0, x1: -1, y0: 0, y1: -1, cx: 0, cy: 0 };
  const s = Math.PI / 2 ** level, n = 2 ** (level + 1), rows = 2 ** level;
  const hw = t.width / 2 / t.scale, hh = t.height / 2 / t.scale;
  let x0 = Math.floor((t.centerLon - hw + Math.PI) / s), x1 = Math.floor((t.centerLon + hw + Math.PI) / s);
  if (x1 - x0 + 1 >= n) {
    x0 = 0;
    x1 = n - 1;
  }
  const y0 = Math.max(0, Math.floor((Math.PI / 2 - Math.min(Math.PI / 2, t.centerLat + hh)) / s));
  const y1 = Math.min(rows - 1, Math.floor((Math.PI / 2 - Math.max(-Math.PI / 2, t.centerLat - hh)) / s));
  return { x0, x1, y0, y1, cx: (t.centerLon + Math.PI) / s, cy: (Math.PI / 2 - t.centerLat) / s };
}
