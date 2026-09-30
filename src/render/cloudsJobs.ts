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
import { buildCloudNoiseRaster, rasterizeClouds, type CloudNoiseRaster, type CloudRasterStats } from './cloudsRaster';

export type CloudJob =
  /** The noise volumes (shape/warp, detail, cells) for the globe textures. */
  | { kind: 'volumes' }
  /** Regime / aux grids, smoothed advection wind and climate analysis for the globe. */
  | { kind: 'grids'; spec: CloudSpec }
  /** Static map raster (RGBA, straight alpha) of the cloud field. */
  | { kind: 'raster'; spec: CloudSpec; w: number; h: number; opacity: number; time: number };

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
      const key = `${job.w}x${job.h}`;
      let raster = rasters.get(key);
      if (!raster) {
        raster = buildCloudNoiseRaster(job.w, job.h);
        rasters.set(key, raster);
      }
      const rgba = new Uint8ClampedArray(job.w * job.h * 4);
      const stats = rasterizeClouds(raster, job.spec, job.opacity, rgba, job.time);
      return { result: { kind: 'raster', w: job.w, h: job.h, rgba, stats, ms: performance.now() - t0 }, transfer: [rgba.buffer as ArrayBuffer] };
    }
  }
}
