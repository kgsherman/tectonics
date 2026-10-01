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
  /**
   * Precision of typed values (the readout is editable), default `step`: the slider drags in
   * `step`s, a typed 23.44 is kept as is.
   */
  fine?: number;
  /** Notable values the slider snaps to when dragged or stepped near them (e.g. Earth's 23.44° tilt). */
  snaps?: readonly number[];
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
  plateSpeed: { min: 10, max: 150, step: 5, fine: 1, label: 'Plate speed', unit: 'mm/yr', hint: 'Mean plate speed (50 mm/yr ≈ Earth)' },
  boundaryRoughness: { min: 0, max: 1, step: 0.05, label: 'Boundary roughness', hint: 'Irregularity of plate boundaries' },
};

type TectonicNumKey = Exclude<keyof TectonicParams, 'mergePlates' | 'seed'>;
export const TECTONIC_SPECS: Record<TectonicNumKey, NumSpec> = {
  dt: { min: 0.25, max: 5, step: 0.25, fine: 0.05, label: 'Time step', unit: 'Myr', hint: 'Simulated time per step', digits: 2 },
  speedScale: { min: 0.1, max: 3, step: 0.05, fine: 0.01, label: 'Plate speed ×', hint: 'Multiplies every plate velocity' },
  maxPlates: { min: 4, max: 32, step: 1, label: 'Max plates', hint: 'Rifting stops at this plate count' },
  riftRate: { min: 0, max: 6, step: 0.1, label: 'Rift rate', unit: '/100 Myr', hint: 'Expected rifting events per 100 Myr' },
  subductionUplift: { min: 0, max: 3, step: 0.05, label: 'Subduction uplift', hint: 'Arc and cordillera building' },
  collisionUplift: { min: 0, max: 3, step: 0.05, label: 'Collision uplift', hint: 'Continental collision orogeny' },
  erosion: { min: 0, max: 3, step: 0.05, label: 'Erosion', hint: 'Erosion and hillslope diffusion rate' },
  hotspotActivity: { min: 0, max: 3, step: 0.05, label: 'Hotspot activity', hint: 'Hotspot volcanism strength' },
};

export type ClimateNumKey = 'axialTilt' | 'solarMultiplier' | 'globalTempOffset' | 'moisture' | 'oceanCurrents';
export const CLIMATE_SPECS: Record<ClimateNumKey, NumSpec> = {
  axialTilt: {
    min: 0, max: 90, step: 0.5, fine: 0.01, snaps: [23.44], label: 'Axial tilt', unit: '°', digits: 1,
    hint: 'Obliquity: drives the seasons (Earth 23.44°; type a value for finer control)',
  },
  solarMultiplier: { min: 0.8, max: 1.2, step: 0.005, fine: 0.001, label: 'Solar output', unit: '×', hint: 'Multiplier on the solar constant', digits: 3 },
  globalTempOffset: { min: -15, max: 15, step: 0.5, fine: 0.1, label: 'Temperature offset', unit: '°C', hint: 'Added to every temperature', digits: 1 },
  moisture: { min: 0.2, max: 2, step: 0.05, label: 'Moisture', unit: '×', hint: 'Evaporation and precipitation multiplier' },
  oceanCurrents: { min: 0, max: 2, step: 0.05, label: 'Ocean heat transport', unit: '×', hint: 'Strength of heat transport by currents' },
};

export const LIVE_INTERVAL_SPEC: NumSpec = {
  min: 2, max: 100, step: 1, label: 'Update every', unit: 'Myr', hint: 'Simulated time between live climate updates',
};
export const SEA_LEVEL_SPEC: NumSpec = {
  min: -2000, max: 2000, step: 10, fine: 1, label: 'Sea level', unit: 'm', hint: 'Display and climate sea level (re-runs the climate)',
};

type ViewNumKey = 'reliefScale' | 'particleCount' | 'detail' | 'cloudDensity';
export const VIEW_SPECS: Record<ViewNumKey, NumSpec> = {
  reliefScale: { min: 0, max: 4, step: 0.1, label: 'Relief exaggeration', unit: '×' },
  particleCount: { min: 1000, max: 16000, step: 500, label: 'Particles' },
  detail: { min: 0, max: 2, step: 0.05, label: 'Terrain detail', unit: '×', hint: 'Procedural terrain amplification' },
  cloudDensity: { min: 0, max: 1, step: 0.05, label: 'Cloud density', unit: '×', hint: 'Cloudiness: 0.4 ≈ Earth-like, 1 = stormy' },
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
  return decimals(spec.step);
}

function decimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Decimals of a typed value (from `fine`, at least the readout's). */
export function fineDigits(spec: NumSpec): number {
  return Math.max(stepDigits(spec), decimals(spec.fine ?? spec.step));
}

const roundTo = (v: number, step: number): number => {
  const d = decimals(step);
  return Number((Math.round(v / step) * step).toFixed(d));
};

/** Strip float noise from grid arithmetic (0.30000000000000004 → 0.3). */
const tidy = (spec: NumSpec, v: number): number => Number(v.toFixed(Math.max(decimals(spec.step), decimals(spec.min), decimals(spec.fine ?? spec.step))));

/** A typed value: clamped, rounded to the spec's `fine` precision (default `step`). */
export function fineValue(spec: NumSpec, v: number): number {
  const fine = spec.fine ?? spec.step;
  return clampTo(spec, roundTo(clampTo(spec, v), fine));
}

/** Snap radius around `snaps` values while dragging (a bit more than half a step). */
const snapRadius = (spec: NumSpec): number => 0.6 * spec.step;

/**
 * A dragged value: the nearest `snaps` value within ~half a step, else the nearest multiple of
 * `step` (from `min`), clamped.
 */
export function snapSliderValue(spec: NumSpec, raw: number): number {
  const v = clampTo(spec, raw);
  let best: number | null = null;
  for (const s of spec.snaps ?? []) if (Math.abs(s - v) <= snapRadius(spec) && (best === null || Math.abs(s - v) < Math.abs(best - v))) best = s;
  if (best !== null) return clampTo(spec, best);
  return clampTo(spec, tidy(spec, roundTo(v - spec.min, spec.step) + spec.min));
}

/**
 * Keyboard step from `v` by `dir` (±1) × `mult` steps: the next grid value (multiple of `step` from
 * `min`) or `snaps` value strictly beyond `v` — so 23.0 → 23.44 → 23.5 → 24.0 with Earth's tilt as
 * a snap value, and an off-grid typed value steps onto the grid.
 */
export function stepSliderValue(spec: NumSpec, v: number, dir: 1 | -1, mult = 1): number {
  const eps = 1e-9 * Math.max(1, Math.abs(spec.max - spec.min));
  const step = spec.step * Math.max(1, mult);
  const k = (v - spec.min) / step;
  const grid = spec.min + (dir > 0 ? Math.floor(k + 1e-9) + 1 : Math.ceil(k - 1e-9) - 1) * step;
  let next = tidy(spec, grid);
  if (mult <= 1) {
    for (const s of spec.snaps ?? []) {
      if (dir > 0 ? s > v + eps && s < next : s < v - eps && s > next) next = s;
    }
  }
  return clampTo(spec, next);
}

/** Parse a typed number ("1,234.5", "−3", "23,44" with a decimal comma, "23.44°"); null when invalid. */
export function parseNumberInput(text: string): number | null {
  // Typographic minus/dashes → '-', drop spaces and a trailing unit ("°", "%", " m", "mm/yr").
  let t = text.trim().replace(/[−‒–]/g, '-').replace(/[\s  ]/g, '').replace(/[^0-9.,]+$/, '');
  // A lone comma with 1–2 decimals is a decimal comma ("23,44"); otherwise commas group thousands.
  if (!t.includes('.') && /^[-+]?\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  else t = t.replace(/,/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** Physics-relevant subset of ClimateParams the user can change. */
export type ClimateKnobs = Pick<ClimateParams, ClimateNumKey | 'retrograde'>;
