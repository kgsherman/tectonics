/**
 * Cloud preprocessing jobs (pure, DOM-free): run by the cloud worker (cloudsWorker.ts) or, where no
 * worker is available (Node tests, worker failure), asynchronously on the calling thread by
 * cloudsWorkerClient.ts. Everything here is too slow for a main-thread frame: the regime grids
 * (4–60 ms per climate/month), the noise volumes (~25 ms once) and the map raster (50–200 ms).
 */
import type { CloudSpec } from '../core/types';
import { resampleGrid } from '../core/grid';
import { buildCloudGrids, type CloudClimate, type CloudGrids } from './cloudsModel';
import {
  buildCloudCellVolume, buildCloudDetailVolume, buildCloudNoiseVolume, cloudCellVolume, cloudDetailVolume, cloudNoiseVolume, type CloudNoiseVolume,
} from './cloudsNoise';
import {
  buildCloudNoiseRaster, rasterizeClouds, type CloudNoiseRaster, type CloudRasterStats, type CloudRasterWindow,
} from './cloudsRaster';

export type CloudJob =
  /** The noise volumes (shape/warp, detail, cells) for the globe textures. */
  | { kind: 'volumes' }
  /**
   * Regime / aux grids, smoothed advection wind and climate analysis for the globe; specs wider than
   * `maxW` are box-averaged down first (standard-quality clouds: ~6× cheaper at half resolution).
   */
  | { kind: 'grids'; spec: CloudSpec; maxW?: number }
  /**
   * Static map raster (RGBA, straight alpha) of the cloud field: the whole world, or the geographic
   * window `win` (a zoomed-in map's tile). Jobs with the same `specKey` carry the same spec: its
   * regime grids are made once (a zoomed map rasterizes dozens of tiles of one spec).
   */
  | { kind: 'raster'; spec: CloudSpec; w: number; h: number; opacity: number; time: number; win?: CloudRasterWindow; specKey?: string };

export interface CloudVolumesResult {
  kind: 'volumes';
  noise: CloudNoiseVolume;
  detail: CloudNoiseVolume;
  cells: CloudNoiseVolume;
}

export interface CloudGridsResult {
  kind: 'grids';
  w: number;
  h: number;
  regime: Uint8Array;
  aux: Uint8Array;
  flowU: Float32Array;
  flowV: Float32Array;
  climate: CloudClimate;
  /** Worker-side compute time (ms). */
  ms: number;
}

export interface CloudRasterResult {
  kind: 'raster';
  w: number;
  h: number;
  /** The window rasterized (undefined: the whole world). */
  win?: CloudRasterWindow;
  /** RGBA (straight alpha); empty when `bitmap` carries the image (worker results). */
  rgba: Uint8ClampedArray;
  /** The image as a bitmap (made in the worker: the main thread only draws it). */
  bitmap?: ImageBitmap;
  stats: CloudRasterStats;
  ms: number;
}

export type CloudJobResult = CloudVolumesResult | CloudGridsResult | CloudRasterResult;

/** Result type of a job kind. */
export type ResultOf<J extends CloudJob> = J extends { kind: 'volumes' } ? CloudVolumesResult
  : J extends { kind: 'grids' } ? CloudGridsResult : CloudRasterResult;

const rasters = new Map<string, CloudNoiseRaster>();
/**
 * Window noise rasters (zoomed map tiles), most recent last: those of a view kept (~1.4 MB per 258²
 * tile), so new clouds for the same view (the next month's clouds) skip the noise.
 */
const windowRasters = new Map<string, CloudNoiseRaster>();
const WINDOW_CACHE = 24;
/** Regime grids of the last keyed spec (raster jobs' specKey). */
let gridsCache: { key: string; grids: CloudGrids } | null = null;

/**
 * Runs a job. `fresh` builds private noise volumes (a worker owns its heap; transferring the shared
 * ones would detach them); in-thread callers reuse the shared volumes.
 */
export function runCloudJob(job: CloudJob, fresh = false): { result: CloudJobResult; transfer: ArrayBuffer[] } {
  const t0 = performance.now();
  switch (job.kind) {
    case 'volumes': {
      const noise = fresh ? buildCloudNoiseVolume() : cloudNoiseVolume();
      const detail = fresh ? buildCloudDetailVolume() : cloudDetailVolume();
      const cells = fresh ? buildCloudCellVolume() : cloudCellVolume();
      const transfer = fresh ? [noise.data.buffer, detail.data.buffer, cells.data.buffer] as ArrayBuffer[] : [];
      return { result: { kind: 'volumes', noise, detail, cells }, transfer };
    }
    case 'grids': {
      const g = buildCloudGrids(job.maxW ? limitSpec(job.spec, job.maxW) : job.spec);
      const result: CloudGridsResult = {
        kind: 'grids', w: g.w, h: g.h, regime: g.regime, aux: g.aux, flowU: g.flowU, flowV: g.flowV, climate: g.climate,
        ms: performance.now() - t0,
      };
      return { result, transfer: [g.regime.buffer, g.aux.buffer, g.flowU.buffer, g.flowV.buffer] as ArrayBuffer[] };
    }
    case 'raster': {
      const { win } = job;
      let raster: CloudNoiseRaster | undefined;
      if (win) {
        const key = `${job.w}x${job.h}@${win.lon0},${win.lon1},${win.lat0},${win.lat1}`;
        raster = windowRasters.get(key);
        if (raster) {
          windowRasters.delete(key);
        } else {
          raster = buildCloudNoiseRaster(job.w, job.h, undefined, undefined, undefined, win);
          while (windowRasters.size >= WINDOW_CACHE) windowRasters.delete(windowRasters.keys().next().value!);
        }
        windowRasters.set(key, raster);
      } else {
        const key = `${job.w}x${job.h}`;
        raster = rasters.get(key);
        if (!raster) {
          raster = buildCloudNoiseRaster(job.w, job.h);
          rasters.set(key, raster);
        }
      }
      let grids: CloudGrids | undefined;
      if (job.specKey) {
        if (gridsCache?.key !== job.specKey) gridsCache = { key: job.specKey, grids: buildCloudGrids(job.spec) };
        grids = gridsCache.grids;
      }
      const rgba = new Uint8ClampedArray(job.w * job.h * 4);
      const stats = rasterizeClouds(raster, job.spec, job.opacity, rgba, job.time, grids);
      const result: CloudRasterResult = { kind: 'raster', w: job.w, h: job.h, win, rgba, stats, ms: performance.now() - t0 };
      return { result, transfer: [rgba.buffer as ArrayBuffer] };
    }
  }
}

/**
 * `spec` box-averaged by an integer factor so it is at most `maxW` wide (unchanged when it already
 * is). Wind cells that are not finite count as calm.
 */
export function limitSpec(spec: CloudSpec, maxW: number): CloudSpec {
  const f = Math.ceil(spec.w / Math.max(1, maxW));
  if (f <= 1) return spec;
  const w = Math.max(1, Math.floor(spec.w / f)), h = Math.max(1, Math.floor(spec.h / f));
  const down = (a: Float32Array): Float32Array => {
    let src = a;
    for (let i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i])) {
        src = Float32Array.from(a, (x) => (Number.isFinite(x) ? x : 0));
        break;
      }
    }
    return resampleGrid(src, spec.w, spec.h, w, h);
  };
  const out: CloudSpec = { w, h, cover: down(spec.cover), quality: spec.quality };
  if (spec.u && spec.v) {
    out.u = down(spec.u);
    out.v = down(spec.v);
  }
  return out;
}
