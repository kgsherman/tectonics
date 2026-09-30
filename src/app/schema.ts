/**
 * Ranges, steps, defaults and labels of every numeric setting — the single source of truth for the
 * sliders, the reducer's clamping and the sanitizing of persisted settings.
 */
import type { ClimateParams, GenerateParams, TectonicParams } from '../core/types';

export interface NumSpec {
  min: number;
  max: number;
  step: number;
  label: string;
  unit?: string;
  /** Short explanation shown as a tooltip. */
  hint?: string;
  /** Decimals for the readout (default: from step). */
  digits?: number;
}

export const MESH_RESOLUTIONS = [40_000, 100_000, 160_000] as const;
export type MeshResolution = (typeof MESH_RESOLUTIONS)[number];

/** Playback speeds (simulation steps per displayed frame). */
export const SPEEDS = [1, 2, 5, 10, 20] as const;

export const CONTINENT_MODES: ReadonlyArray<{ value: GenerateParams['continentMode']; label: string; title: string }> = [
  { value: 'scattered', label: 'Scattered', title: 'Several continents of varied size' },
  { value: 'supercontinent', label: 'Pangaea', title: 'One supercontinent plus fragments' },
  { value: 'archipelago', label: 'Islands', title: 'Archipelago: many small landmasses' },
];

type WorldNumKey = 'plateCount' | 'continentalFraction' | 'hotspotCount' | 'plateSpeed' | 'boundaryRoughness';
export const WORLD_SPECS: Record<WorldNumKey, NumSpec> = {
  plateCount: { min: 3, max: 30, step: 1, label: 'Plates', hint: 'Number of tectonic plates' },
  continentalFraction: { min: 0.05, max: 0.7, step: 0.01, label: 'Continental crust', unit: '%', hint: 'Share of the surface covered by continental crust' },
  hotspotCount: { min: 0, max: 24, step: 1, label: 'Hotspots', hint: 'Mantle plumes building island chains and swells' },
  plateSpeed: { min: 10, max: 150, step: 5, label: 'Plate speed', unit: 'mm/yr', hint: 'Mean plate speed (50 mm/yr ≈ Earth)' },
  boundaryRoughness: { min: 0, max: 1, step: 0.05, label: 'Boundary roughness', hint: 'Irregularity of plate boundaries' },
};

type TectonicNumKey = Exclude<keyof TectonicParams, 'mergePlates' | 'seed'>;
export const TECTONIC_SPECS: Record<TectonicNumKey, NumSpec> = {
  dt: { min: 0.25, max: 5, step: 0.25, label: 'Time step', unit: 'Myr', hint: 'Simulated time per step', digits: 2 },
  speedScale: { min: 0.1, max: 3, step: 0.05, label: 'Plate speed ×', hint: 'Multiplies every plate velocity' },
  maxPlates: { min: 4, max: 32, step: 1, label: 'Max plates', hint: 'Rifting stops at this plate count' },
  riftRate: { min: 0, max: 6, step: 0.1, label: 'Rift rate', unit: '/100 Myr', hint: 'Expected rifting events per 100 Myr' },
  subductionUplift: { min: 0, max: 3, step: 0.05, label: 'Subduction uplift', hint: 'Arc and cordillera building' },
  collisionUplift: { min: 0, max: 3, step: 0.05, label: 'Collision uplift', hint: 'Continental collision orogeny' },
  erosion: { min: 0, max: 3, step: 0.05, label: 'Erosion', hint: 'Erosion and hillslope diffusion rate' },
  hotspotActivity: { min: 0, max: 3, step: 0.05, label: 'Hotspot activity', hint: 'Hotspot volcanism strength' },
};

export type ClimateNumKey = 'axialTilt' | 'solarMultiplier' | 'globalTempOffset' | 'moisture' | 'oceanCurrents';
export const CLIMATE_SPECS: Record<ClimateNumKey, NumSpec> = {
  axialTilt: { min: 0, max: 90, step: 0.5, label: 'Axial tilt', unit: '°', hint: 'Obliquity: drives the seasons', digits: 1 },
  solarMultiplier: { min: 0.8, max: 1.2, step: 0.005, label: 'Solar output', unit: '×', hint: 'Multiplier on the solar constant', digits: 3 },
  globalTempOffset: { min: -15, max: 15, step: 0.5, label: 'Temperature offset', unit: '°C', hint: 'Added to every temperature', digits: 1 },
  moisture: { min: 0.2, max: 2, step: 0.05, label: 'Moisture', unit: '×', hint: 'Evaporation and precipitation multiplier' },
  oceanCurrents: { min: 0, max: 2, step: 0.05, label: 'Ocean heat transport', unit: '×', hint: 'Strength of heat transport by currents' },
};

export const LIVE_INTERVAL_SPEC: NumSpec = {
  min: 2, max: 100, step: 1, label: 'Every', unit: 'Myr', hint: 'Simulated time between live climate updates',
};
export const SEA_LEVEL_SPEC: NumSpec = {
  min: -2000, max: 2000, step: 10, label: 'Sea level', unit: 'm', hint: 'Display and climate sea level (re-runs the climate)',
};

type ViewNumKey = 'reliefScale' | 'particleCount' | 'detail' | 'cloudDensity';
export const VIEW_SPECS: Record<ViewNumKey, NumSpec> = {
  reliefScale: { min: 0, max: 4, step: 0.1, label: 'Relief exaggeration', unit: '×' },
  particleCount: { min: 1000, max: 16000, step: 500, label: 'Particles' },
  detail: { min: 0, max: 2, step: 0.05, label: 'Terrain detail', unit: '×', hint: 'Procedural terrain amplification' },
  cloudDensity: { min: 0.1, max: 1, step: 0.05, label: 'Cloud density', unit: '×', hint: 'Display scale on the climate’s cloud cover (1 = all cloud, incl. thin cloud, drawn opaque)' },
};

export const SEASON_SECONDS_SPEC: NumSpec = { min: 0.4, max: 3, step: 0.1, label: 'Month duration', unit: 's' };

/** Climate grids: full (1°) and live/fast (2°). */
export const CLIMATE_GRID_FULL = { w: 360, h: 180 } as const;
export const CLIMATE_GRID_LIVE = { w: 180, h: 90 } as const;

/** Paint sizes: paused/full quality and playback preview. */
export const PAINT_FULL = { w: 2048, h: 1024 } as const;
export const PAINT_PREVIEW = { w: 1024, h: 512 } as const;

export function clampTo(spec: NumSpec, v: number): number {
  if (!Number.isFinite(v)) return spec.min;
  return v < spec.min ? spec.min : v > spec.max ? spec.max : v;
}

/** Number of decimals implied by a step (0.25 → 2, 5 → 0). */
export function stepDigits(spec: NumSpec): number {
  if (spec.digits !== undefined) return spec.digits;
  const s = String(spec.step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Physics-relevant subset of ClimateParams the user can change. */
export type ClimateKnobs = Pick<ClimateParams, ClimateNumKey | 'retrograde'>;
