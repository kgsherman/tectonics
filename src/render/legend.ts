/** Legends for every layer (gradient stops in true units, or categorical swatches). */
import type { LayerId, LegendSpec, PaintOptions, PaintSources, RGB } from '../core/types';
import { KOPPEN_CLASSES } from '../climate/koppen';
import {
  CM_AGE, CM_BATHY, CM_HYPSO, CM_PRECIP_LOG, CM_PRESSURE, CM_SST, CM_TEMP, CM_WIND, CURRENT_LUT, cmapColor, currentIndex, encodeSrgb,
} from './colormaps';
import type { Colormap } from './colormaps';
import { ISOBAR_BOLD_HPA, ISOBAR_HPA } from './layersClimate';
import { BOUNDARY_COLORS } from './overlay';
import { PAL } from './satelliteBiome';
import { COLD_DESERT, DEPTH_MAX, DEPTH_N, HOT_DESERT, OCEAN_WARM, ROCK_DRY, SEA_ICE, SNOW, TUNDRA_DRY } from './satellitePalette';
import { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM } from '../core/types';

type Stop = { value: number; color: RGB; label?: string };

function stopsOf(cm: Colormap, values: number[], fmt: (v: number) => string, map: (v: number) => number = (v) => v): Stop[] {
  return values.map((v) => ({ value: v, color: cmapColor(cm, map(v)), label: fmt(v) }));
}

/** Compact mm label (1.2k style above 10 000). */
function fmtMm(v: number): string {
  return v >= 10000 ? `${Math.round(v / 1000)}k` : `${v}`;
}

const enc = (lin: ArrayLike<number>): RGB => [encodeSrgb(lin[0]), encodeSrgb(lin[1]), encodeSrgb(lin[2])];

/** Linear-light colour at depth d (m) from a depth ramp, as sRGB. */
function depthColor(ramp: Float32Array, d: number): RGB {
  const i = 3 * Math.min(DEPTH_N - 1, Math.round(Math.sqrt(d / DEPTH_MAX) * (DEPTH_N - 1)));
  return enc([ramp[i], ramp[i + 1], ramp[i + 2]]);
}

/** Lithology ramp colour at noise value v ∈ [-1, 1], as sRGB. */
function lithColor(ramp: Float32Array, v: number): RGB {
  const i = 3 * Math.round((v + 1) * 31.5);
  return enc([ramp[i], ramp[i + 1], ramp[i + 2]]);
}

/** Representative satellite swatches, taken from the painter's own palette. */
const SATELLITE_ITEMS: Array<{ color: RGB; label: string }> = [
  { color: enc(PAL.tropical), label: 'Tropical rainforest' },
  { color: enc(PAL.leafOn), label: 'Temperate forest' },
  { color: enc(PAL.boreal), label: 'Boreal forest (taiga)' },
  { color: enc(PAL.grassLush), label: 'Grassland / cropland' },
  { color: enc(PAL.grassDryWarm), label: 'Savanna / dry grass' },
  { color: lithColor(HOT_DESERT, 0.3), label: 'Hot desert (sand)' },
  { color: lithColor(COLD_DESERT, 0), label: 'Cold desert / gravel' },
  { color: enc(TUNDRA_DRY), label: 'Tundra / alpine meadow' },
  { color: enc(ROCK_DRY), label: 'Bare rock' },
  { color: enc(SNOW), label: 'Snow & ice' },
  { color: depthColor(OCEAN_WARM, 20), label: 'Shallow sea' },
  { color: depthColor(OCEAN_WARM, 4000), label: 'Deep ocean' },
  { color: enc(SEA_ICE), label: 'Sea ice' },
];

export function buildLegend(layer: LayerId, src: PaintSources, opts: PaintOptions): LegendSpec | null {
  const annual = opts.month < 0;
  switch (layer) {
    case 'satellite':
      return { kind: 'categorical', title: 'Surface (satellite)', items: SATELLITE_ITEMS.map((i) => ({ ...i })) };
    case 'elevation': {
      const depths = [-8000, -5000, -3000, -1000, -150, 0];
      const heights = [200, 600, 1200, 2000, 3000, 4200, 5500];
      const stops: Stop[] = [
        ...depths.map((d) => ({ value: d, color: cmapColor(CM_BATHY, -d), label: `${d} m` })),
        ...heights.map((e) => ({ value: e, color: cmapColor(CM_HYPSO, e), label: `${e} m` })),
      ];
      return { kind: 'gradient', title: 'Elevation', unit: 'm', stops };
    }
    case 'plates': {
      const s = src.snapshot;
      if (!s) return { kind: 'categorical', title: 'Plates', items: [] };
      return {
        kind: 'categorical',
        title: 'Plates',
        items: s.plates.map((p) => ({ color: [p.color[0], p.color[1], p.color[2]] as RGB, label: p.name, code: String(p.id) })),
      };
    }
    case 'crust':
      return {
        kind: 'categorical',
        title: 'Crust type',
        items: [
          { color: [196, 164, 112], label: 'Continental (land)' },
          { color: [132, 122, 104], label: 'Continental (submerged)' },
          { color: [62, 96, 142], label: 'Oceanic' },
        ],
      };
    case 'crustAge':
      return {
        kind: 'gradient', title: 'Ocean crust age (isochrons every 20 Myr; grey = continental)', unit: 'Myr',
        stops: stopsOf(CM_AGE, [0, 20, 40, 70, 100, 140, 180, 250], (v) => `${v}`),
      };
    case 'temperature':
      return {
        kind: 'gradient',
        title: annual ? 'Annual mean temperature (line = 0 °C)' : 'Temperature (line = 0 °C isotherm)',
        unit: '°C',
        stops: stopsOf(CM_TEMP, [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50], (v) => `${v}`),
      };
    case 'precipitation': {
      // Stops at the colormap's own (log-spaced) stops so the evenly spaced legend bar is faithful.
      const mm = [1, 3, 10, 30, 100, 300, 1000, 4000];
      return {
        kind: 'gradient',
        title: annual ? 'Annual precipitation (log scale)' : 'Precipitation (log scale)',
        unit: annual ? 'mm/yr' : 'mm/month',
        stops: mm.map((m) => ({ value: annual ? 12 * m : m, color: cmapColor(CM_PRECIP_LOG, Math.log10(m)), label: fmtMm(annual ? 12 * m : m) })),
      };
    }
    case 'pressure':
      return {
        kind: 'gradient',
        title: `Sea-level pressure (isobars every ${ISOBAR_HPA} hPa, bold every ${ISOBAR_BOLD_HPA}; H / L centres)`,
        unit: 'hPa',
        stops: stopsOf(CM_PRESSURE, [981, 989, 997, 1005, 1013, 1021, 1029, 1037, 1045], (v) => `${v}`, (v) => v - 1013),
      };
    case 'sst':
      return {
        kind: 'gradient', title: 'Sea-surface temperature (white = sea ice)', unit: '°C',
        stops: stopsOf(CM_SST, [-2, 4, 10, 16, 22, 27, 32], (v) => `${v}`),
      };
    case 'wind':
      return { kind: 'gradient', title: annual ? 'Annual mean wind speed' : 'Wind speed', unit: 'm/s', stops: stopsOf(CM_WIND, [0, 2, 4, 6, 8, 10, 13, 16, 20], (v) => `${v}`) };
    case 'currents': {
      // Colour = SST anomaly vs the zonal ocean mean (at a typical current speed); brightness and
      // streamlet length = speed.
      const anoms = [-3, -2, -1, 0, 1, 2, 3];
      return {
        kind: 'gradient',
        title: 'Ocean currents: colour = SST anomaly vs zonal mean (blue cold, red warm); brightness & arrows = speed',
        unit: '°C',
        stops: anoms.map((a) => {
          const i = currentIndex(0.45, a);
          return { value: a, color: [CURRENT_LUT[i], CURRENT_LUT[i + 1], CURRENT_LUT[i + 2]] as RGB, label: a > 0 ? `+${a}` : `${a}` };
        }),
      };
    }
    case 'koppen': {
      const c = src.climate;
      let ids = KOPPEN_CLASSES.slice(1).map((k) => k.id);
      if (c) {
        const present = new Uint8Array(KOPPEN_CLASSES.length);
        for (let i = 0; i < c.koppen.length; i++) present[c.koppen[i]] = 1;
        const onLand = ids.filter((id) => present[id]);
        if (onLand.length > 0) ids = onLand;
      }
      return {
        kind: 'categorical',
        title: 'Köppen–Geiger climate',
        items: ids.map((id) => {
          const k = KOPPEN_CLASSES[id];
          return { color: [k.color[0], k.color[1], k.color[2]] as RGB, label: k.name, code: k.code };
        }),
      };
    }
    default:
      return null;
  }
}

/** Legend for the overlay's plate-boundary colours (for the UI's overlay key). */
export const BOUNDARY_LEGEND: LegendSpec = {
  kind: 'categorical',
  title: 'Plate boundaries',
  items: [
    { color: BOUNDARY_COLORS[BOUNDARY_CONVERGENT], label: 'Convergent' },
    { color: BOUNDARY_COLORS[BOUNDARY_DIVERGENT], label: 'Divergent' },
    { color: BOUNDARY_COLORS[BOUNDARY_TRANSFORM], label: 'Transform' },
  ],
};
