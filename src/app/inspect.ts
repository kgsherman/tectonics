/**
 * Hover inspector sampling (SPEC.md §10): everything shown for the point under the cursor, from
 * the main thread's own copies — mesh, latest snapshot clone, latest climate, last height map.
 * Pure (no DOM) so it is unit-tested.
 */
import { KOPPEN_CLASSES } from '../climate/koppen';
import { sampleClimateAt, type ClimateSample } from '../climate/sample';
import { EARTH_RADIUS_KM } from '../core/constants';
import { gridIndexAt } from '../core/grid';
import { latLonToVec, tangentBasis } from '../core/math3';
import type { ClimateResult, KoppenGroup, RGB, SphereMesh, WorldSnapshot } from '../core/types';
import { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM, CRUST_CONTINENTAL } from '../core/types';
import { sampleSnapshotAt } from '../tectonics/draft';

export interface HeightMapRef {
  data: Float32Array;
  w: number;
  h: number;
}

export interface InspectContext {
  mesh: SphereMesh | null;
  snapshot: WorldSnapshot | null;
  climate: ClimateResult | null;
  heightMap: HeightMapRef | null;
  month: number;
  seaLevel: number;
}

export type BoundaryKind = 'convergent' | 'divergent' | 'transform';

export interface TectonicInfo {
  cell: number;
  plateId: number;
  plateName: string;
  plateColor: RGB;
  /** Local plate surface speed (km/Myr) and direction (degrees clockwise from north). */
  speed: number;
  bearing: number;
  continental: boolean;
  age: number;
  boundary: BoundaryKind | null;
  orogeny: number;
  /** Snapshot (mesh-resolution) elevation, m. */
  meshElevation: number;
}

export interface ClimateInfo {
  koppenId: number;
  code: string;
  name: string;
  group: KoppenGroup;
  color: RGB;
  temp: Float32Array;
  precip: Float32Array;
  tempAnnual: number;
  precipAnnual: number;
  /** Values for the selected month (annual means when month = −1). */
  monthTemp: number;
  monthPrecip: number;
  sst: number;
  seaIce: number;
  windSpeed: number;
  windBearing: number;
  pressure: number;
  snow: number;
  cloud: number;
}

export interface InspectSample {
  lat: number;
  lon: number;
  /** Displayed surface elevation (height map, else snapshot), m; null without a world. */
  elevation: number | null;
  land: boolean;
  tectonic: TectonicInfo | null;
  climate: ClimateInfo | null;
}

const BOUNDARY_NAMES: Record<number, BoundaryKind> = {
  [BOUNDARY_CONVERGENT]: 'convergent',
  [BOUNDARY_DIVERGENT]: 'divergent',
  [BOUNDARY_TRANSFORM]: 'transform',
};

/** Bearing (° clockwise from north) of a tangent vector at p. */
function bearingOf(p: [number, number, number], v: [number, number, number]): number {
  const { east, north } = tangentBasis(p);
  const e = v[0] * east[0] + v[1] * east[1] + v[2] * east[2];
  const n = v[0] * north[0] + v[1] * north[1] + v[2] * north[2];
  const b = (Math.atan2(e, n) * 180) / Math.PI;
  return b < 0 ? b + 360 : b;
}

export function heightAt(hm: HeightMapRef, lat: number, lon: number): number {
  return hm.data[gridIndexAt(hm.w, hm.h, lat, lon)];
}

/** Reused climate sample (sampleClimateAt writes into it; values are copied out below). */
let scratch: ClimateSample | undefined;

export function inspectAt(ctx: InspectContext, lat: number, lon: number, hint?: number): InspectSample {
  const out: InspectSample = { lat, lon, elevation: null, land: false, tectonic: null, climate: null };
  const { mesh, snapshot, climate, heightMap } = ctx;

  if (mesh && snapshot && snapshot.n === mesh.n) {
    const s = sampleSnapshotAt(mesh, snapshot, lat, lon, hint);
    const p = latLonToVec(lat, lon);
    let speed = 0;
    let bearing = 0;
    if (s.plate) {
      const w = s.plate.omega;
      const v: [number, number, number] = [w[1] * p[2] - w[2] * p[1], w[2] * p[0] - w[0] * p[2], w[0] * p[1] - w[1] * p[0]];
      speed = Math.hypot(v[0], v[1], v[2]) * EARTH_RADIUS_KM;
      bearing = speed > 1e-9 ? bearingOf(p, v) : 0;
    }
    out.tectonic = {
      cell: s.cell,
      plateId: s.plate?.id ?? -1,
      plateName: s.plate?.name ?? '—',
      plateColor: s.plate ? [s.plate.color[0], s.plate.color[1], s.plate.color[2]] : [128, 128, 128],
      speed,
      bearing,
      continental: s.crust === CRUST_CONTINENTAL,
      age: s.age,
      boundary: BOUNDARY_NAMES[s.boundary] ?? null,
      orogeny: s.orogeny,
      meshElevation: s.elev,
    };
    out.elevation = s.elev;
  }
  if (heightMap && heightMap.data.length === heightMap.w * heightMap.h) out.elevation = heightAt(heightMap, lat, lon);
  if (out.elevation !== null) out.land = out.elevation > ctx.seaLevel;

  if (climate) {
    const elevOverride = out.elevation ?? undefined;
    scratch = sampleClimateAt(climate, lat, lon, ctx.month, elevOverride, scratch);
    if (out.elevation === null) out.land = scratch.land;
    // Köppen classes describe land (the Köppen layer colors land pixels only; koppenAll classifies
    // sea cells "as if land"): over the displayed sea report Ocean.
    const k = out.land ? KOPPEN_CLASSES[scratch.koppen] ?? KOPPEN_CLASSES[0] : KOPPEN_CLASSES[0];
    const m = ctx.month;
    const p = latLonToVec(lat, lon);
    const { east, north } = tangentBasis(p);
    const wind: [number, number, number] = [
      scratch.windU * east[0] + scratch.windV * north[0],
      scratch.windU * east[1] + scratch.windV * north[1],
      scratch.windU * east[2] + scratch.windV * north[2],
    ];
    const windSpeed = Math.hypot(scratch.windU, scratch.windV);
    out.climate = {
      koppenId: k.id,
      code: k.code,
      name: k.name,
      group: k.group,
      color: [k.color[0], k.color[1], k.color[2]],
      temp: scratch.temp.slice(),
      precip: scratch.precip.slice(),
      tempAnnual: scratch.tempAnnual,
      precipAnnual: scratch.precipAnnual,
      monthTemp: m >= 0 ? scratch.temp[m] : scratch.tempAnnual,
      monthPrecip: m >= 0 ? scratch.precip[m] : scratch.precipAnnual,
      sst: scratch.sst,
      seaIce: scratch.seaIce,
      windSpeed,
      windBearing: windSpeed > 1e-6 ? bearingOf(p, wind) : 0,
      pressure: scratch.pressure,
      snow: scratch.snow,
      cloud: scratch.cloud,
    };
  }
  return out;
}
