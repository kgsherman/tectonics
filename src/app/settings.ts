/**
 * Settings persistence in localStorage. Everything read back is validated field by field against
 * the defaults (wrong types, unknown enum values and out-of-range numbers never reach the app);
 * storage failures (private mode, quota, disabled storage) are swallowed and reported as false.
 */
import type { OverlayFlags } from '../core/types';
import { isLayerId } from '../worker/layerInfo';
import { CONTINENT_MODES, MESH_RESOLUTIONS, SPEEDS } from './schema';
import {
  DEFAULT_SETTINGS, normalizeClimate, normalizeSpeed, normalizeTectonic, normalizeView, normalizeWorld, TABS,
  type LightingChoice, type ParticleChoice, type Settings, type ViewKind,
} from './state';
import { clampTo, SEA_LEVEL_SPEC, SEASON_SECONDS_SPEC } from './schema';

export const SETTINGS_KEY = 'worldgen.settings.v1';

/** Subset of the Web Storage API (tests pass a Map-backed fake). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
function oneOf<T extends string | number>(v: unknown, allowed: readonly T[], d: T): T {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : d;
}

/** Merge an untrusted object onto the defaults, keeping only well-typed, in-range values. */
export function sanitizeSettings(raw: unknown): Settings {
  const D = DEFAULT_SETTINGS;
  const r = isRec(raw) ? raw : {};
  const w = isRec(r.world) ? r.world : {};
  const t = isRec(r.tectonic) ? r.tectonic : {};
  const c = isRec(r.climate) ? r.climate : {};
  const v = isRec(r.view) ? r.view : {};
  const o = isRec(v.overlays) ? v.overlays : {};

  const world = normalizeWorld({
    seed: num(w.seed, D.world.seed),
    meshN: oneOf(w.meshN, MESH_RESOLUTIONS, D.world.meshN),
    plateCount: num(w.plateCount, D.world.plateCount),
    continentalFraction: num(w.continentalFraction, D.world.continentalFraction),
    continentMode: oneOf(w.continentMode, CONTINENT_MODES.map((m) => m.value), D.world.continentMode),
    hotspotCount: num(w.hotspotCount, D.world.hotspotCount),
    plateSpeed: num(w.plateSpeed, D.world.plateSpeed),
    boundaryRoughness: num(w.boundaryRoughness, D.world.boundaryRoughness),
  });
  const tectonic = normalizeTectonic({
    dt: num(t.dt, D.tectonic.dt),
    maxPlates: num(t.maxPlates, D.tectonic.maxPlates),
    riftRate: num(t.riftRate, D.tectonic.riftRate),
    mergePlates: bool(t.mergePlates, D.tectonic.mergePlates),
    subductionUplift: num(t.subductionUplift, D.tectonic.subductionUplift),
    collisionUplift: num(t.collisionUplift, D.tectonic.collisionUplift),
    erosion: num(t.erosion, D.tectonic.erosion),
    hotspotActivity: num(t.hotspotActivity, D.tectonic.hotspotActivity),
    speedScale: num(t.speedScale, D.tectonic.speedScale),
    seed: num(t.seed, D.tectonic.seed),
  });
  const climate = normalizeClimate({
    axialTilt: num(c.axialTilt, D.climate.axialTilt),
    solarMultiplier: num(c.solarMultiplier, D.climate.solarMultiplier),
    globalTempOffset: num(c.globalTempOffset, D.climate.globalTempOffset),
    moisture: num(c.moisture, D.climate.moisture),
    oceanCurrents: num(c.oceanCurrents, D.climate.oceanCurrents),
    retrograde: bool(c.retrograde, D.climate.retrograde),
    live: bool(c.live, D.climate.live),
    liveIntervalMyr: num(c.liveIntervalMyr, D.climate.liveIntervalMyr),
  });
  const overlays: OverlayFlags = {
    boundaries: bool(o.boundaries, D.view.overlays.boundaries),
    graticule: bool(o.graticule, D.view.overlays.graticule),
    coastlines: bool(o.coastlines, D.view.overlays.coastlines),
  };
  const view = normalizeView({
    view: oneOf<ViewKind>(v.view, ['globe', 'map'], D.view.view),
    layer: isLayerId(v.layer) ? v.layer : D.view.layer,
    overlays,
    reliefScale: num(v.reliefScale, D.view.reliefScale),
    lighting: oneOf<LightingChoice>(v.lighting, ['auto', 'flat', 'relief', 'sun'], D.view.lighting),
    particles: oneOf<ParticleChoice>(v.particles, ['off', 'wind', 'currents'], D.view.particles),
    particleCount: num(v.particleCount, D.view.particleCount),
    clouds: bool(v.clouds, D.view.clouds),
    cloudDensity: num(v.cloudDensity, D.view.cloudDensity),
    detail: num(v.detail, D.view.detail),
  });
  return {
    tab: oneOf(r.tab, TABS.map((x) => x.id), D.tab),
    world,
    tectonic,
    climate,
    view,
    seaLevel: clampTo(SEA_LEVEL_SPEC, num(r.seaLevel, D.seaLevel)),
    speed: normalizeSpeed(oneOf(r.speed, SPEEDS, D.speed)),
    seasonSeconds: clampTo(SEASON_SECONDS_SPEC, num(r.seasonSeconds, D.seasonSeconds)),
  };
}

/** Browser localStorage, or null where it is unavailable/blocked. */
export function browserStorage(): KeyValueStorage | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function loadSettings(storage: KeyValueStorage | null): Settings {
  if (!storage) return sanitizeSettings(null);
  try {
    const text = storage.getItem(SETTINGS_KEY);
    return sanitizeSettings(text ? JSON.parse(text) : null);
  } catch {
    return sanitizeSettings(null);
  }
}

/** Returns false when the settings could not be written. */
export function saveSettings(storage: KeyValueStorage | null, settings: Settings): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
