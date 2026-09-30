/**
 * Reference renderings of ClimateResult fields for inspection (not the showcase painter):
 * plain colormaps at the climate grid resolution, resampled to the requested size, with coastlines
 * and vector arrows where useful.
 */
import { KOPPEN_CLASSES } from '../../src/climate/koppen';
import type { ClimateResult, RGB } from '../../src/core/types';
import {
  blendPixel, colormapImage, createImage, drawArrows, drawCoastlines, PRECIP_LOG_STOPS, PRESSURE_STOPS,
  SPEED_STOPS, TEMPERATURE_STOPS, type ColorStops, type Image,
} from '../png';
import { monthSlice, resampleNearest } from './gridUtil';

export const CLIMATE_IMAGE_LAYERS = [
  'temperature', 'precipitation', 'pressure', 'sst', 'wind', 'currents', 'koppen', 'seaIce', 'snow', 'cloud',
] as const;
export type ClimateImageLayer = (typeof CLIMATE_IMAGE_LAYERS)[number];

const WIND_STOPS: ColorStops = [
  [0, [25, 25, 50]], [2, [40, 70, 140]], [4, [40, 130, 170]], [6, [80, 190, 140]], [8, [210, 220, 90]],
  [11, [240, 140, 50]], [15, [180, 30, 30]],
];
const FRACTION_STOPS: ColorStops = [[0, [20, 30, 50]], [1, [245, 245, 250]]];
const LAND_GRAY: RGB = [120, 120, 120];
const OCEAN_KOPPEN: RGB = [25, 40, 70];

/** Render a climate layer for `month` (0..11, or −1 = annual mean) at W×H. */
export function renderClimateLayer(layer: ClimateImageLayer, c: ClimateResult, month: number, W: number, H: number): Image {
  const { w, h } = c;
  const n = w * h;
  const up = <T extends Float32Array | Uint8Array>(f: T): T => resampleNearest(f, w, h, W, H);
  const landUp = up(c.land);
  let img: Image;
  switch (layer) {
    case 'temperature':
      img = colormapImage(up(month < 0 ? c.tempAnnual : monthSlice(c.temp, n, month)), W, H, TEMPERATURE_STOPS);
      break;
    case 'precipitation': {
      // Monthly totals are annualized (×12) so one log colormap serves both.
      const p = month < 0 ? c.precipAnnual : monthSlice(c.precip, n, month).map((v) => v * 12);
      img = colormapImage(up(p), W, H, PRECIP_LOG_STOPS, (v) => Math.log10(Math.max(1, v)));
      break;
    }
    case 'pressure': {
      img = colormapImage(up(monthSlice(c.pressure, n, month)), W, H, PRESSURE_STOPS);
      addArrows(img, c, monthSlice(c.windU, n, month), monthSlice(c.windV, n, month), 10, [20, 20, 20]);
      break;
    }
    case 'sst': {
      img = colormapImage(up(monthSlice(c.sst, n, month)), W, H, TEMPERATURE_STOPS);
      const ice = up(monthSlice(c.seaIce, n, month));
      for (let i = 0; i < W * H; i++) {
        if (landUp[i]) paint(img, i, LAND_GRAY);
        else if (ice[i] > 0) blendPixel(img, i % W, Math.floor(i / W), [250, 250, 255], Math.min(1, ice[i]));
      }
      break;
    }
    case 'wind': {
      const u = monthSlice(c.windU, n, month), v = monthSlice(c.windV, n, month);
      const sp = new Float32Array(n);
      for (let i = 0; i < n; i++) sp[i] = Math.hypot(u[i], v[i]);
      img = colormapImage(up(sp), W, H, WIND_STOPS);
      addArrows(img, c, u, v, 10, [245, 245, 245]);
      break;
    }
    case 'currents': {
      const u = monthSlice(c.currentU, n, month), v = monthSlice(c.currentV, n, month);
      const sp = new Float32Array(n);
      for (let i = 0; i < n; i++) sp[i] = c.land[i] ? 0 : Math.hypot(u[i], v[i]);
      img = colormapImage(up(sp), W, H, SPEED_STOPS);
      for (let i = 0; i < W * H; i++) if (landUp[i]) paint(img, i, LAND_GRAY);
      addArrows(img, c, u, v, 0.5, [250, 250, 250], (i) => c.land[i] === 1);
      break;
    }
    case 'koppen': {
      const k = up(c.koppen);
      img = createImage(W, H);
      for (let i = 0; i < W * H; i++) paint(img, i, k[i] > 0 ? KOPPEN_CLASSES[k[i]].color : OCEAN_KOPPEN);
      break;
    }
    case 'seaIce':
      img = colormapImage(up(monthSlice(c.seaIce, n, month)), W, H, FRACTION_STOPS);
      break;
    case 'snow':
      img = colormapImage(up(monthSlice(c.snow, n, month)), W, H, FRACTION_STOPS);
      break;
    case 'cloud':
      img = colormapImage(up(monthSlice(c.cloud, n, month)), W, H, FRACTION_STOPS);
      break;
  }
  drawCoastlines(img, c.land, w, h, [15, 15, 15], 0.6);
  return img;
}

function paint(img: Image, i: number, c: RGB): void {
  img.rgba[4 * i] = c[0];
  img.rgba[4 * i + 1] = c[1];
  img.rgba[4 * i + 2] = c[2];
}

/** Arrow spacing on the image, pixels. */
const ARROW_SPACING_PX = 24;

/**
 * Arrows on a regular ~24 px lattice; `fullSpeed` (m/s) draws an arrow one spacing long (longer ones
 * are capped by drawArrows at two spacings).
 */
function addArrows(img: Image, c: ClimateResult, u: ArrayLike<number>, v: ArrayLike<number>, fullSpeed: number, color: RGB, skip?: (i: number) => boolean): void {
  const scale = img.width / c.w;
  const step = Math.max(1, Math.round(ARROW_SPACING_PX / scale));
  drawArrows(img, c.w, c.h, u, v, step, (step * scale) / fullSpeed, color, skip);
}
