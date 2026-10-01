/**
 * Cloud preprocessing jobs (pure, DOM-free): run by the cloud worker (cloudsWorker.ts) or, where no
 * worker is available (Node tests, worker failure), asynchronously on the calling thread by
 * cloudsWorkerClient.ts. Everything here is too slow for a main-thread frame: the regime grids
 * (4–60 ms per climate/month), the noise volumes (~25 ms once) and the map raster (50–200 ms).
 */
import type { CloudSpec } from '../core/types';
import { buildCloudGrids, type CloudClimate } from './cloudsModel';
import {
  buildCloudCellVolume, buildCloudDetailVolume, buildCloudNoiseVolume, cloudCellVolume, cloudDetailVolume, cloudNoiseVolume, type CloudNoiseVolume,
} from './cloudsNoise';
import {
  buildCloudNoiseRaster, rasterizeClouds, type CloudNoiseRaster, type CloudRasterStats, type CloudRasterWindow,
} from './cloudsRaster';

export type CloudJob =
  /** The noise volumes (shape/warp, detail, cells) for the globe textures. */
  | { kind: 'volumes' }
  /** Regime / aux grids, smoothed advection wind and climate analysis for the globe. */
  | { kind: 'grids'; spec: CloudSpec }
  /**
   * Static map raster (RGBA, straight alpha) of the cloud field: the whole world, or the geographic
   * window `win` (a zoomed-in map's view, rasterized at screen resolution).
   */
  | { kind: 'raster'; spec: CloudSpec; w: number; h: number; opacity: number; time: number; win?: CloudRasterWindow };

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
/** Window noise rasters (zoomed map views), most recent last; a few kept (the view comes back to them). */
const windowRasters = new Map<string, CloudNoiseRaster>();
const WINDOW_CACHE = 2;

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
      const g = buildCloudGrids(job.spec);
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
      const rgba = new Uint8ClampedArray(job.w * job.h * 4);
      const stats = rasterizeClouds(raster, job.spec, job.opacity, rgba, job.time);
      const result: CloudRasterResult = { kind: 'raster', w: job.w, h: job.h, win, rgba, stats, ms: performance.now() - t0 };
      return { result, transfer: [rgba.buffer as ArrayBuffer] };
    }
  }
}
