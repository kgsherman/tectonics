/**
 * Shared, deterministic test fixtures so each module can be tested without the others'
 * implementations. Owned by the contract (edit only additively).
 */
import { EARTH_RADIUS_KM, LAPSE_RATE } from '../../src/core/constants';
import { gridLat } from '../../src/core/grid';
import { angleBetween, latLonToVec, omegaFromDirection } from '../../src/core/math3';
import { createNoise3, fbm3, ridged3 } from '../../src/core/noise';
import { Rng } from '../../src/core/rng';
import { createSphereMesh } from '../../src/core/sphereMesh';
import type { ClimateParams, ClimateResult, PlateSpec, SphereMesh, Vec3, WorldDraft, WorldSnapshot } from '../../src/core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../../src/core/types';
import { classifyKoppen } from '../../src/climate/koppen';
import type { DynamicsResult } from '../../src/climate/internal';
import { classifyBoundaries, computePlateInfos, oceanDepthForAge, plateColor, voronoiPlates } from '../../src/tectonics/draft';

const meshCache = new Map<number, SphereMesh>();
/** Cached mesh (default 4000 cells). */
export function smallMesh(n = 4000): SphereMesh {
  let m = meshCache.get(n);
  if (!m) {
    m = createSphereMesh(n);
    meshCache.set(n, m);
  }
  return m;
}

export const FIXTURE_CLIMATE_PARAMS: ClimateParams = {
  gridW: 90,
  gridH: 45,
  axialTilt: 23.44,
  solarMultiplier: 1,
  globalTempOffset: 0,
  seaLevel: 0,
  moisture: 1,
  oceanCurrents: 1,
  retrograde: false,
  fast: true,
};

function spec(id: number, omega: Vec3): PlateSpec {
  return { id, name: `P${id}`, color: plateColor(id - 1), omega };
}

/**
 * Two-plate worlds for kinematic tests.
 *  - 'transform': plate 0 = southern hemisphere (fixed), plate 1 = northern hemisphere rotating
 *    about the z axis (pure strike-slip along the equator), speed km/Myr at the equator.
 *  - 'cap': plate 1 = spherical cap of `capRadiusDeg` centred at (0°, 0°) moving east at `speed`;
 *    plate 0 = the rest, fixed. Leading (east) edge convergent, trailing (west) edge divergent.
 */
export function twoPlateDraft(
  mesh: SphereMesh,
  mode: 'transform' | 'cap',
  opts: { speed?: number; capRadiusDeg?: number; capCrust?: number; restCrust?: number; age?: number } = {},
): WorldDraft {
  const n = mesh.n;
  const speed = opts.speed ?? 50;
  const age = opts.age ?? 50;
  const plate = new Int16Array(n);
  const crust = new Uint8Array(n);
  const elev = new Float32Array(n);
  const ages = new Float32Array(n).fill(age);
  const capR = ((opts.capRadiusDeg ?? 35) * Math.PI) / 180;
  const c0 = latLonToVec(0, 0);
  for (let i = 0; i < n; i++) {
    const p: Vec3 = [mesh.xyz[3 * i], mesh.xyz[3 * i + 1], mesh.xyz[3 * i + 2]];
    const k = mode === 'transform' ? (p[2] >= 0 ? 1 : 0) : angleBetween(p, c0) < capR ? 1 : 0;
    plate[i] = k;
    const ct = k === 1 ? (opts.capCrust ?? CRUST_OCEANIC) : (opts.restCrust ?? CRUST_OCEANIC);
    crust[i] = ct;
    elev[i] = ct === CRUST_CONTINENTAL ? 400 : oceanDepthForAge(age);
  }
  const w1: Vec3 = mode === 'transform' ? [0, 0, speed / EARTH_RADIUS_KM] : omegaFromDirection(c0, 1, 0, speed);
  return {
    n,
    plate,
    crust,
    elev,
    age: ages,
    plates: [spec(1, [0, 0, 0]), spec(2, w1)],
    hotspots: [],
    time: 0,
    seed: 7,
    nextPlateId: 3,
    stepIndex: 0,
  };
}

/** A plausible random world snapshot built only from core + draft helpers. */
export function syntheticSnapshot(mesh: SphereMesh, seed = 1, plateCount = 8): WorldSnapshot {
  const rng = new Rng(seed);
  const n = mesh.n;
  const seeds = Array.from({ length: plateCount }, () => rng.unitVector());
  const plate = voronoiPlates(mesh, seeds, 0.6, seed);
  const plates: PlateSpec[] = seeds.map((s, k) => {
    const ang = rng.float(0, 2 * Math.PI);
    return spec(k + 1, omegaFromDirection(s, Math.cos(ang), Math.sin(ang), rng.float(20, 80)));
  });
  const boundary = classifyBoundaries(mesh, plate, plates);
  const noise = createNoise3(seed * 13 + 5);
  const crust = new Uint8Array(n);
  const elev = new Float32Array(n);
  const age = new Float32Array(n);
  const orogeny = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = mesh.xyz[3 * i], y = mesh.xyz[3 * i + 1], z = mesh.xyz[3 * i + 2];
    const c = fbm3(noise, x * 1.6, y * 1.6, z * 1.6, 5);
    const mountains = ridged3(noise, x * 4 + 11, y * 4, z * 4, 4);
    if (c > 0.12) {
      crust[i] = CRUST_CONTINENTAL;
      elev[i] = 150 + 900 * (c - 0.12) + (boundary[i] === 1 ? 2500 : 0) + 1200 * mountains * mountains;
      age[i] = 500 + 1000 * (c + 1);
      orogeny[i] = boundary[i] === 1 ? 2000 : 300 * mountains;
    } else {
      crust[i] = CRUST_OCEANIC;
      age[i] = Math.max(0, 90 + 90 * fbm3(noise, x * 3 - 7, y * 3, z * 3, 3));
      elev[i] = c > 0.05 ? -150 - 1500 * (0.12 - c) / 0.07 : oceanDepthForAge(age[i]);
    }
  }
  return {
    id: 1000 + seed,
    time: 0,
    n,
    plate,
    elev,
    crust,
    age,
    boundary,
    orogeny,
    plates: computePlateInfos(mesh, plate, crust, plates),
    hotspots: [{ pos: rng.unitVector(), strength: 1, radius: 0.04 }],
  };
}

/** Month-dependent declination (radians); NH summer solstice ≈ mid/late June. */
function declination(m: number, tiltDeg: number): number {
  return ((tiltDeg * Math.PI) / 180) * Math.sin((2 * Math.PI * (m + 0.5 - 2.7)) / 12);
}

/**
 * Analytic latitude-based stand-in for the dynamics stage (for hydrology/painter tests).
 * `elev` (w*h, m) optional; default: an idealized 40°-wide continent from 60°S to 70°N with a
 * western ridge.
 */
export function zonalDynamics(w: number, h: number, elevIn?: Float32Array, params: Partial<ClimateParams> = {}): DynamicsResult {
  const P: ClimateParams = { ...FIXTURE_CLIMATE_PARAMS, gridW: w, gridH: h, ...params };
  const N = w * h;
  const elev = elevIn ?? idealContinentElevation(w, h);
  const land = new Uint8Array(N);
  const landFraction = new Float32Array(N);
  const surfaceHeight = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    land[i] = elev[i] > P.seaLevel ? 1 : 0;
    landFraction[i] = land[i];
    surfaceHeight[i] = land[i] ? elev[i] - P.seaLevel : 0;
  }
  const M = 12 * N;
  const f = () => new Float32Array(M);
  const d: DynamicsResult = {
    w, h, params: P, land, landFraction, elev, surfaceHeight,
    temp: f(), sst: f(), seaIce: f(), pressure: f(), windU: f(), windV: f(), steerU: f(), steerV: f(),
    ascent: f(), baroclinic: f(), currentU: f(), currentV: f(), upwelling: f(), timings: {}, stats: {},
  };
  for (let m = 0; m < 12; m++) {
    const dec = (declination(m, P.axialTilt) * 180) / Math.PI;
    const itcz = 0.35 * dec;
    for (let r = 0; r < h; r++) {
      const latDeg = (gridLat(h, r) * 180) / Math.PI;
      const s = Math.sin((latDeg * Math.PI) / 180);
      const seasonal = Math.sin((dec * Math.PI) / 180) * Math.sign(latDeg) * Math.abs(s);
      const tMean = 28 - 44 * s * s;
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        const k = m * N + i;
        const isLand = land[i] === 1;
        const amp = isLand ? 40 : 9;
        const tSea = tMean + amp * seasonal * Math.sign(latDeg) * Math.sign(latDeg);
        const t = tMean + amp * seasonal + P.globalTempOffset - (isLand ? LAPSE_RATE * surfaceHeight[i] : 0);
        d.temp[k] = t;
        d.sst[k] = Math.max(-1.8, tMean + 9 * seasonal);
        d.seaIce[k] = tSea < -2 ? Math.min(1, (-2 - tSea) / 8) : 0;
        const a = Math.abs(latDeg);
        d.pressure[k] =
          1013 - 7 * Math.exp(-((latDeg - itcz) ** 2) / 128) + 8 * Math.exp(-((a - 30) ** 2) / 200) -
          12 * Math.exp(-((a - 60) ** 2) / 128) + 5 * Math.exp(-((a - 90) ** 2) / 200);
        let u: number, v: number;
        if (a < 30) { u = -6; v = latDeg > itcz ? -2 : 2; }
        else if (a < 60) { u = 8; v = latDeg > 0 ? 1 : -1; }
        else { u = -4; v = 0; }
        d.windU[k] = u; d.windV[k] = v;
        d.steerU[k] = 1.2 * u; d.steerV[k] = 1.2 * v;
        d.ascent[k] = Math.exp(-((latDeg - itcz) ** 2) / 72) - 0.7 * Math.exp(-((a - 27) ** 2) / 128) + 0.4 * Math.exp(-((a - 55) ** 2) / 200);
        d.baroclinic[k] = Math.exp(-((a - 45) ** 2) / 288);
        if (!isLand) {
          d.currentU[k] = 0.1 * Math.sign(u);
          d.currentV[k] = 0;
        }
      }
    }
  }
  return d;
}

/** Idealized continent: 40° wide (lon -20..20) from 60°S to 70°N at 300 m, 3 km ridge near its west coast. */
export function idealContinentElevation(w: number, h: number, ridge = true): Float32Array {
  const e = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const lat = (gridLat(h, r) * 180) / Math.PI;
    for (let c = 0; c < w; c++) {
      const lon = -180 + ((c + 0.5) * 360) / w;
      let v = -4000;
      if (lat > -60 && lat < 70 && lon > -20 && lon < 20) {
        v = 300;
        if (ridge && lon > -17 && lon < -13) v = 3000;
      }
      e[r * w + c] = v;
    }
  }
  return e;
}

/** Analytic ClimateResult (zonal pattern) for painter/app/view tests. */
export function zonalClimate(w: number, h: number, elevIn?: Float32Array, params: Partial<ClimateParams> = {}): ClimateResult {
  const d = zonalDynamics(w, h, elevIn, params);
  const N = w * h;
  const M = 12 * N;
  const precip = new Float32Array(M);
  const evap = new Float32Array(M);
  const snow = new Float32Array(M);
  const cloud = new Float32Array(M);
  const koppen = new Uint8Array(N);
  const koppenAll = new Uint8Array(N);
  const tempAnnual = new Float32Array(N);
  const precipAnnual = new Float32Array(N);
  const tt = new Float32Array(12);
  const pp = new Float32Array(12);
  for (let i = 0; i < N; i++) {
    const r = Math.floor(i / w);
    const lat = gridLat(h, r);
    const latDeg = (lat * 180) / Math.PI;
    for (let m = 0; m < 12; m++) {
      const k = m * N + i;
      const asc = d.ascent[k];
      const p = Math.max(3, 60 + 220 * asc + 60 * d.baroclinic[k]) * (d.land[i] ? 0.8 : 1);
      precip[k] = p;
      evap[k] = d.land[i] ? Math.min(p * 0.6, Math.max(0, d.temp[k]) * 6) : 90 * Math.max(0.1, 1 - Math.abs(latDeg) / 80);
      snow[k] = d.temp[k] < -1 ? 1 : d.temp[k] < 2 ? (2 - d.temp[k]) / 3 : 0;
      cloud[k] = Math.min(1, p / 220);
      tt[m] = d.temp[k];
      pp[m] = p;
      tempAnnual[i] += d.temp[k] / 12;
      precipAnnual[i] += p;
    }
    koppenAll[i] = classifyKoppen(tt, pp, lat < 0);
    koppen[i] = d.land[i] ? koppenAll[i] : 0;
  }
  return {
    id: 77,
    sourceSnapshotId: 0,
    sourceTime: 0,
    w, h,
    params: d.params,
    land: d.land,
    landFraction: d.landFraction,
    elev: d.elev,
    temp: d.temp,
    precip, evap, snow, cloud,
    pressure: d.pressure,
    windU: d.windU, windV: d.windV,
    sst: d.sst, seaIce: d.seaIce,
    currentU: d.currentU, currentV: d.currentV,
    koppen, koppenAll, tempAnnual, precipAnnual,
    timings: {}, stats: {},
  };
}
