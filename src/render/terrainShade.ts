/**
 * Metric gradients of the height map and relief shading helpers (equirectangular, lon wraps).
 */
import { EARTH_RADIUS_KM } from '../core/constants';
import type { PaintCache } from './paintCache';

export interface GradientScales {
  w: number;
  h: number;
  /** Per row: 1 / (2·Δx) in 1/m (central difference east–west; Δx shrinks with cos(lat)). */
  invDx: Float64Array;
  /** 1 / (2·Δy) in 1/m. */
  invDy: number;
  /** Equatorial pixel size, km. */
  pixelKm: number;
  /**
   * Slope normalisation (Δ/10 km)^0.4: the RMS slope of fractal terrain measured over a baseline Δ
   * falls like Δ^(H−1); multiplying by this makes slope thresholds resolution independent.
   */
  slopeNorm: number;
}

export function gradientScales(w: number, h: number, cache: PaintCache): GradientScales {
  return cache.getOrBuild(`gradscales|${w}x${h}`, () => {
    const R = EARTH_RADIUS_KM * 1000;
    const dLat = Math.PI / h, dLon = (2 * Math.PI) / w;
    const invDx = new Float64Array(h);
    for (let r = 0; r < h; r++) {
      const cl = Math.cos(Math.PI / 2 - (r + 0.5) * dLat);
      invDx[r] = 1 / (2 * dLon * Math.max(1e-4, cl) * R);
    }
    const pixelKm = (dLon * R) / 1000;
    return { w, h, invDx, invDy: 1 / (2 * dLat * R), pixelKm, slopeNorm: Math.pow(pixelKm / 10, 0.4) };
  });
}

/** Light from the north-west, 40° above the horizon (east, north, up). */
const SUN_ALT = (40 * Math.PI) / 180;
const LX = -Math.cos(SUN_ALT) * Math.SQRT1_2;
const LY = Math.cos(SUN_ALT) * Math.SQRT1_2;
const LZ = Math.sin(SUN_ALT);

/**
 * Relief shading factor (1 on flat ground) for a metric gradient (gx east, gy north; m/m) with
 * vertical exaggeration `ex`. Range ≈ [0, 1/sin(40°)].
 */
export function hillshade(gx: number, gy: number, ex: number): number {
  const nx = -ex * gx, ny = -ex * gy;
  const d = (nx * LX + ny * LY + LZ) / Math.sqrt(nx * nx + ny * ny + 1);
  return d > 0 ? d / LZ : 0;
}

/** Vertical exaggeration for relief shading at a given pixel size (coarser pixels need more). */
export function shadeExaggeration(g: GradientScales): number {
  return 4 * g.slopeNorm;
}
