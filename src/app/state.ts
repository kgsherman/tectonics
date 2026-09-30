/**
 * Application state and its pure reducer. `settings` are user choices (persisted); `runtime`
 * mirrors what the workers report (never persisted).
 */
import type { GenerateParams, LayerId, OverlayFlags, TectonicParams, TectonicStats } from '../core/types';
import type { ClimatePurpose, KeyframeInfo, PerfStats } from '../worker/protocol';
import {
  clampTo, CLIMATE_SPECS, LIVE_INTERVAL_SPEC, MESH_RESOLUTIONS, SEA_LEVEL_SPEC, SEASON_SECONDS_SPEC, SPEEDS, TECTONIC_SPECS,
  VIEW_SPECS, WORLD_SPECS, type ClimateKnobs, type MeshResolution, type NumSpec,
} from './schema';

export type TabId = 'world' | 'plates' | 'simulate' | 'climate' | 'view';
export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'world', label: 'World' },
  { id: 'plates', label: 'Plates' },
  { id: 'simulate', label: 'Simulate' },
  { id: 'climate', label: 'Climate' },
  { id: 'view', label: 'View' },
];

export type ViewKind = 'globe' | 'map';
export type LightingChoice = 'auto' | 'flat' | 'relief' | 'sun';
export type ParticleChoice = 'off' | 'wind' | 'currents';

export interface WorldSettings extends GenerateParams {
  meshN: MeshResolution;
}

export interface ClimateSettings extends ClimateKnobs {
  /** Recompute the climate automatically (fast during playback, full when paused). */
  live: boolean;
  /** Myr of simulated time between live (fast) climate updates. */
  liveIntervalMyr: number;
}

export interface ViewSettings {
  view: ViewKind;
  layer: LayerId;
  overlays: OverlayFlags;
  reliefScale: number;
  lighting: LightingChoice;
  particles: ParticleChoice;
  particleCount: number;
  clouds: boolean;
  /** Display multiplier on cloud cover (the model's cover includes thin cloud). */
  cloudDensity: number;
  detail: number;
}

export interface Settings {
  tab: TabId;
  world: WorldSettings;
  tectonic: TectonicParams;
  climate: ClimateSettings;
  view: ViewSettings;
  /** The one display + climate sea level (m). */
  seaLevel: number;
  /** Simulation steps per playback frame. */
  speed: number;
  /** Seconds per month when playing seasons. */
  seasonSeconds: number;
}

export type ClimatePhase = 'none' | 'computing' | 'ready' | 'error';

export interface ClimateStatus {
  phase: ClimatePhase;
  /** Info on the climate currently held (0 = none). */
  id: number;
  sourceTime: number;
  sourceSnapshotId: number;
  fast: boolean;
  ms: number;
  stats: Record<string, number>;
  /** Job in progress. */
  purpose: ClimatePurpose | null;
  stage: string;
  progress: number;
  error: string | null;
}

export interface TaskInfo {
  id: string;
  label: string;
  /** 0..1, or null for indeterminate. */
  progress: number | null;
}

export interface RuntimeState {
  worldLoaded: boolean;
  meshN: number;
  worldSeed: number;
  playing: boolean;
  /** Live simulation time (the sim worker's, which runs 1–3 steps ahead of the picture during playback). */
  time: number;
  /**
   * Time of the live state in the picture (the last frame shown), null until a frame of this world
   * arrived. The timeline shows it so the counter advances with every frame and never runs ahead.
   */
  shownTime: number | null;
  steps: number;
  snapshotId: number;
  stats: TectonicStats | null;
  perf: PerfStats;
  /** -1 = annual view, else 0..11. */
  month: number;
  seasonsPlaying: boolean;
  climate: ClimateStatus;
  keyframes: KeyframeInfo[];
  keyframeInterval: number;
  /** Keyframe on screen (null = live state). */
  viewingKeyframe: number | null;
  tasks: TaskInfo[];
  editorActive: boolean;
  /**
   * World-tab settings the world on screen was generated with (worldParamsKey), '' for worlds from
   * the plate editor: the World tab tells the user when "Generate" would apply changed settings.
   */
  worldParams: string;
}

export interface AppState {
  settings: Settings;
  runtime: RuntimeState;
}

/* ------------------------------------------------------------------ */
/* Defaults                                                             */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS: Settings = {
  tab: 'world',
  world: {
    seed: 1, meshN: 100_000, plateCount: 12, continentalFraction: 0.35, continentMode: 'scattered', hotspotCount: 8,
    plateSpeed: 50, boundaryRoughness: 0.5,
  },
  tectonic: {
    dt: 1, maxPlates: 24, riftRate: 1.5, mergePlates: true, subductionUplift: 1, collisionUplift: 1, erosion: 1,
    hotspotActivity: 1, speedScale: 1, seed: 1,
  },
  climate: {
    axialTilt: 23.44, solarMultiplier: 1, globalTempOffset: 0, moisture: 1, oceanCurrents: 1, retrograde: false,
    live: true, liveIntervalMyr: 10,
  },
  view: {
    view: 'globe', layer: 'satellite', overlays: { boundaries: false, graticule: false, coastlines: false },
    reliefScale: 1, lighting: 'auto', particles: 'off', particleCount: 8000, clouds: true, cloudDensity: 0.4, detail: 1,
  },
  seaLevel: 0,
  speed: 1,
  seasonSeconds: 0.8,
};

export const EMPTY_CLIMATE: ClimateStatus = {
  phase: 'none', id: 0, sourceTime: 0, sourceSnapshotId: 0, fast: false, ms: 0, stats: {}, purpose: null, stage: '',
  progress: 0, error: null,
};

export function initialRuntime(): RuntimeState {
  return {
    worldLoaded: false, meshN: 0, worldSeed: 0, playing: false, time: 0, shownTime: null, steps: 0, snapshotId: 0, stats: null,
    perf: { stepsPerSec: 0, framesPerSec: 0, lastStepMs: 0, lastPaintMs: 0 }, month: -1, seasonsPlaying: false,
    climate: { ...EMPTY_CLIMATE }, keyframes: [], keyframeInterval: 0, viewingKeyframe: null, tasks: [], editorActive: false,
    worldParams: '',
  };
}

export function initialState(settings: Settings = DEFAULT_SETTINGS): AppState {
  return { settings, runtime: initialRuntime() };
}

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */

export type Action =
  | { type: 'setTab'; tab: TabId }
  | { type: 'patchWorld'; patch: Partial<WorldSettings> }
  | { type: 'patchTectonic'; patch: Partial<TectonicParams> }
  | { type: 'resetTectonic' }
  | { type: 'patchClimate'; patch: Partial<ClimateSettings> }
  | { type: 'resetClimate' }
  | { type: 'setSeaLevel'; value: number }
  | { type: 'patchView'; patch: Partial<Omit<ViewSettings, 'overlays'>> }
  | { type: 'setOverlay'; key: keyof OverlayFlags; value: boolean }
  | { type: 'setSpeed'; speed: number }
  | { type: 'setSeasonSeconds'; value: number }
  | { type: 'setMonth'; month: number }
  | { type: 'stepMonth'; delta: number }
  | { type: 'setSeasonsPlaying'; playing: boolean }
  | { type: 'worldLoaded'; meshN: number; seed: number; time: number; stats: TectonicStats; paramsKey?: string }
  | { type: 'status'; playing: boolean; time: number; steps: number; perf: PerfStats }
  /** A frame of the live state (not a history keyframe) is on screen. */
  | { type: 'frameShown'; time: number }
  | { type: 'snapshot'; snapshotId: number; stats: TectonicStats }
  | { type: 'history'; keyframes: KeyframeInfo[]; intervalMyr: number; viewing: number | null }
  | { type: 'climateStarted'; purpose: ClimatePurpose }
  | { type: 'climateProgress'; stage: string; fraction: number }
  | { type: 'climateDone'; id: number; sourceTime: number; sourceSnapshotId: number; fast: boolean; ms: number; stats: Record<string, number> }
  | { type: 'climateFailed'; error: string }
  | { type: 'climateIdle' }
  | { type: 'climateCleared' }
  | { type: 'taskStart'; id: string; label: string; progress?: number | null }
  | { type: 'taskProgress'; id: string; progress: number | null; label?: string }
  | { type: 'taskEnd'; id: string }
  | { type: 'setEditorActive'; active: boolean };

/* ------------------------------------------------------------------ */
/* Reducer                                                              */
/* ------------------------------------------------------------------ */

function clampSpecs<T extends object>(obj: T, specs: Partial<Record<keyof T, NumSpec>>): T {
  const out = { ...obj };
  for (const k of Object.keys(specs) as Array<keyof T>) {
    const spec = specs[k];
    const v = out[k];
    if (spec && typeof v === 'number') (out as Record<keyof T, unknown>)[k] = clampTo(spec, v);
  }
  return out;
}

const INTEGER_WORLD_KEYS = ['plateCount', 'hotspotCount'] as const;

export function normalizeWorld(w: WorldSettings): WorldSettings {
  const o = clampSpecs(w, WORLD_SPECS);
  for (const k of INTEGER_WORLD_KEYS) o[k] = Math.round(o[k]);
  o.seed = normalizeSeed(o.seed);
  if (!(MESH_RESOLUTIONS as readonly number[]).includes(o.meshN)) o.meshN = DEFAULT_SETTINGS.world.meshN;
  return o;
}

/** Seeds are unsigned 32-bit integers. */
export function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 1;
  return Math.abs(Math.trunc(seed)) % 4294967296;
}

export function normalizeTectonic(t: TectonicParams): TectonicParams {
  const o = clampSpecs(t, TECTONIC_SPECS);
  o.maxPlates = Math.round(o.maxPlates);
  o.seed = normalizeSeed(o.seed);
  return o;
}

export function normalizeClimate(c: ClimateSettings): ClimateSettings {
  const o = clampSpecs(c, CLIMATE_SPECS);
  o.liveIntervalMyr = clampTo(LIVE_INTERVAL_SPEC, o.liveIntervalMyr);
  return o;
}

export function normalizeView(v: ViewSettings): ViewSettings {
  const o = clampSpecs(v, VIEW_SPECS);
  o.particleCount = Math.round(o.particleCount);
  return o;
}

/** Nearest allowed playback speed. */
export function normalizeSpeed(speed: number): number {
  let best: number = SPEEDS[0];
  for (const s of SPEEDS) if (Math.abs(s - speed) < Math.abs(best - speed)) best = s;
  return best;
}

/** Month index in −1..11 (−1 = annual). */
export function normalizeMonth(m: number): number {
  if (!Number.isFinite(m)) return -1;
  const r = Math.round(m);
  return r < -1 ? -1 : r > 11 ? 11 : r;
}

/**
 * Step through Annual, Jan … Dec cyclically. From the annual view, +1 goes to January and −1 to
 * December; stepping past December/January wraps around the calendar (the annual view is only
 * re-entered explicitly).
 */
export function stepMonth(month: number, delta: number): number {
  const d = Math.round(delta);
  if (d === 0) return normalizeMonth(month);
  if (month < 0) return d > 0 ? (d - 1) % 12 : ((12 + (d % 12)) % 12);
  return (((month + d) % 12) + 12) % 12;
}

function withRuntime(s: AppState, patch: Partial<RuntimeState>): AppState {
  return { ...s, runtime: { ...s.runtime, ...patch } };
}

function withSettings(s: AppState, patch: Partial<Settings>): AppState {
  return { ...s, settings: { ...s.settings, ...patch } };
}

export function reduce(s: AppState, a: Action): AppState {
  const st = s.settings;
  const rt = s.runtime;
  switch (a.type) {
    case 'setTab':
      return st.tab === a.tab ? s : withSettings(s, { tab: a.tab });
    case 'patchWorld':
      return withSettings(s, { world: normalizeWorld({ ...st.world, ...a.patch }) });
    case 'patchTectonic':
      return withSettings(s, { tectonic: normalizeTectonic({ ...st.tectonic, ...a.patch }) });
    case 'resetTectonic':
      return withSettings(s, { tectonic: { ...DEFAULT_SETTINGS.tectonic, seed: st.tectonic.seed } });
    case 'patchClimate':
      return withSettings(s, { climate: normalizeClimate({ ...st.climate, ...a.patch }) });
    case 'resetClimate':
      return withSettings(s, {
        climate: { ...DEFAULT_SETTINGS.climate, live: st.climate.live, liveIntervalMyr: st.climate.liveIntervalMyr },
        seaLevel: DEFAULT_SETTINGS.seaLevel,
      });
    case 'setSeaLevel':
      return withSettings(s, { seaLevel: clampTo(SEA_LEVEL_SPEC, a.value) });
    case 'patchView':
      return withSettings(s, { view: normalizeView({ ...st.view, ...a.patch }) });
    case 'setOverlay':
      return st.view.overlays[a.key] === a.value
        ? s
        : withSettings(s, { view: { ...st.view, overlays: { ...st.view.overlays, [a.key]: a.value } } });
    case 'setSpeed':
      return withSettings(s, { speed: normalizeSpeed(a.speed) });
    case 'setSeasonSeconds':
      return withSettings(s, { seasonSeconds: clampTo(SEASON_SECONDS_SPEC, a.value) });
    case 'setMonth':
      return withRuntime(s, { month: normalizeMonth(a.month) });
    case 'stepMonth':
      return withRuntime(s, { month: stepMonth(rt.month, a.delta) });
    case 'setSeasonsPlaying':
      return withRuntime(s, { seasonsPlaying: a.playing, month: a.playing && rt.month < 0 ? 0 : rt.month });
    case 'worldLoaded':
      return withRuntime(s, {
        worldLoaded: true, meshN: a.meshN, worldSeed: a.seed, time: a.time, shownTime: null, steps: a.stats.steps, stats: a.stats, playing: false,
        viewingKeyframe: null, worldParams: a.paramsKey ?? rt.worldParams,
      });
    case 'status':
      return withRuntime(s, { playing: a.playing, time: a.time, steps: a.steps, perf: a.perf });
    case 'frameShown':
      return rt.shownTime === a.time ? s : withRuntime(s, { shownTime: a.time });
    case 'snapshot':
      return withRuntime(s, { snapshotId: a.snapshotId, stats: a.stats });
    case 'history':
      return withRuntime(s, { keyframes: a.keyframes, keyframeInterval: a.intervalMyr, viewingKeyframe: a.viewing });
    case 'climateStarted':
      return withRuntime(s, { climate: { ...rt.climate, phase: 'computing', purpose: a.purpose, stage: '', progress: 0, error: null } });
    case 'climateProgress':
      return withRuntime(s, { climate: { ...rt.climate, stage: a.stage, progress: Math.max(0, Math.min(1, a.fraction)) } });
    case 'climateDone':
      return withRuntime(s, {
        climate: {
          ...rt.climate, phase: 'ready', id: a.id, sourceTime: a.sourceTime, sourceSnapshotId: a.sourceSnapshotId, fast: a.fast,
          ms: a.ms, stats: a.stats, purpose: null, stage: '', progress: 1, error: null,
        },
      });
    case 'climateFailed':
      return withRuntime(s, { climate: { ...rt.climate, phase: 'error', purpose: null, error: a.error } });
    case 'climateIdle':
      return withRuntime(s, {
        climate: { ...rt.climate, phase: rt.climate.id ? 'ready' : 'none', purpose: null, stage: '', progress: 0 },
      });
    case 'climateCleared':
      return withRuntime(s, { climate: { ...EMPTY_CLIMATE } });
    case 'taskStart': {
      const tasks = rt.tasks.filter((t) => t.id !== a.id);
      tasks.push({ id: a.id, label: a.label, progress: a.progress ?? null });
      return withRuntime(s, { tasks });
    }
    case 'taskProgress': {
      if (!rt.tasks.some((t) => t.id === a.id)) return s;
      const tasks = rt.tasks.map((t) => (t.id === a.id ? { ...t, progress: a.progress, label: a.label ?? t.label } : t));
      return withRuntime(s, { tasks });
    }
    case 'taskEnd':
      return rt.tasks.some((t) => t.id === a.id) ? withRuntime(s, { tasks: rt.tasks.filter((t) => t.id !== a.id) }) : s;
    case 'setEditorActive':
      return withRuntime(s, { editorActive: a.active });
    default: {
      const never: never = a;
      throw new Error(`reduce: unknown action ${JSON.stringify(never)}`);
    }
  }
}

/** Identity of the World-tab settings (what "Generate world" would build). */
export function worldParamsKey(w: WorldSettings): string {
  return JSON.stringify([w.seed, w.meshN, w.plateCount, w.continentalFraction, w.continentMode, w.hotspotCount, w.plateSpeed, w.boundaryRoughness]);
}

/** Time of the state on screen: the keyframe being viewed, else the live frame shown (sim time before the first). */
export function displayedTime(rt: RuntimeState): number {
  const k = rt.viewingKeyframe;
  return k !== null && rt.keyframes[k] ? rt.keyframes[k].time : rt.shownTime ?? rt.time;
}

/** The world displayed is newer than the climate (climate computed for another state). */
export function climateIsStale(rt: RuntimeState): boolean {
  return rt.climate.id !== 0 && rt.climate.sourceSnapshotId !== rt.snapshotId;
}
