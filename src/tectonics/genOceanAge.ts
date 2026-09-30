import { EARTH_RADIUS_KM } from '../core/constants';
import { createNoise3, fbm3 } from '../core/noise';
import type { SphereMesh } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';
import type { BoundaryKinematics } from './genKinematics';
import { isNormalDominated } from './genKinematics';
import { labelComponents, multiSourceDijkstra } from './genGraph';

// Synthetic oceanic crust ages consistent with the plate motions: crust is born at age 0 on the
// divergent boundaries (mid-ocean ridges) and ages with the time the plate needed to carry it from the
// ridge, age = distance / half-spreading-rate. Distances run inside each plate (a plate's crust comes
// from its own ridges) and only through oceanic crust.

/** Opening rate (km/Myr) above which a boundary counts as a spreading ridge (the sim's new-crust gate). */
export const RIDGE_MIN_OPENING = 5;
/** Floor on the half-spreading rate used for ages (ultra-slow ridges would otherwise age everything). */
const MIN_HALF_RATE = 8;
/**
 * Ages saturate smoothly toward MAX_OCEAN_AGE (SPEC §5: oceanic ages 0–180 Myr; Earth's oldest in-situ
 * seafloor ≈ 180 Myr).
 */
const AGE_KNEE = 140;
export const MAX_OCEAN_AGE = 180;
/** Crust on plates with no ridge of their own is at least this old (its ridge was consumed). */
const ORPHAN_MIN_AGE = 60;
/** Ridge segments shorter than this (km) are ignored (flicker on near-transform boundaries). */
const MIN_RIDGE_KM = 500;

/** Smoothly saturating clamp: identity below AGE_KNEE, asymptotic to MAX_OCEAN_AGE above. */
export function saturateAge(t: number): number {
  if (t <= AGE_KNEE) return Math.max(0, t);
  const span = MAX_OCEAN_AGE - AGE_KNEE;
  return AGE_KNEE + span * (1 - Math.exp(-(t - AGE_KNEE) / span));
}

/**
 * Oceanic crust age (Myr) per cell (continental cells are left 0). `kin` must be computed from the
 * same plate labels and motions. Always finite.
 */
export function oceanAges(mesh: SphereMesh, plate: Int16Array, crust: Uint8Array, kin: BoundaryKinematics, noiseSeed: number): Float32Array {
  const n = mesh.n;
  const ocean = new Uint8Array(n);
  for (let i = 0; i < n; i++) ocean[i] = crust[i] === CRUST_CONTINENTAL ? 0 : 1;
  const ridge = new Uint8Array(n);
  for (let i = 0; i < n; i++) ridge[i] = ocean[i] && kin.diverge[i] > RIDGE_MIN_OPENING && isNormalDominated(kin, i) ? 1 : 0;
  const runs = labelComponents(mesh, ridge, ridge);
  // A ridge run is ~2 cells wide (both flanks), so a segment of length L holds ≈ 2·L/spacing cells.
  const minRun = Math.max(4, Math.round((2 * MIN_RIDGE_KM) / (mesh.spacing * EARTH_RADIUS_KM)));
  const sources: number[] = [];
  const halfRate: number[] = [];
  for (let i = 0; i < n; i++) {
    if (ridge[i] && runs.size[runs.comp[i]] >= minRun) {
      sources.push(i);
      halfRate.push(Math.max(MIN_HALF_RATE, 0.5 * kin.diverge[i]));
    }
  }
  const age = new Float32Array(n);
  // Time to reach each cell from its fastest-arriving ridge: Dijkstra with per-source speed.
  const speed = new Float32Array(halfRate.map((h) => h / EARTH_RADIUS_KM)); // rad/Myr
  const tags = sources.map((_, s) => s);
  const own = multiSourceDijkstra(mesh, sources, tags, { sameLabel: plate, mask: ocean, tagSpeed: speed });
  // Fallback for oceanic crust its plate's ridges cannot reach: nearest ridge of any plate (the
  // parent ridge has been subducted), crossing continents at 3× cost, and at least ORPHAN_MIN_AGE.
  let any: Float64Array | null = null;
  let noise: ReturnType<typeof createNoise3> | null = null;
  for (let i = 0; i < n; i++) {
    if (!ocean[i]) continue;
    let t = own.dist[i];
    if (!(t < Infinity)) {
      if (!any && sources.length > 0) {
        const cost = new Float32Array(n);
        for (let c = 0; c < n; c++) cost[c] = ocean[c] ? 1 : 3;
        any = multiSourceDijkstra(mesh, sources, tags, { cellCost: cost, tagSpeed: speed }).dist;
      }
      if (any && any[i] < Infinity) {
        t = Math.max(ORPHAN_MIN_AGE, ORPHAN_MIN_AGE * 0.5 + any[i]);
      } else {
        // No spreading anywhere (e.g. all plates at rest): mature, gently varying ocean floor.
        noise ??= createNoise3(noiseSeed + 31);
        const x = mesh.xyz[3 * i], y = mesh.xyz[3 * i + 1], z = mesh.xyz[3 * i + 2];
        t = 90 + 50 * fbm3(noise, x * 1.5, y * 1.5, z * 1.5, 3);
      }
    }
    age[i] = saturateAge(t);
  }
  return age;
}
