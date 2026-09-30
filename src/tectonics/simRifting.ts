import { EARTH_RADIUS_KM } from '../core/constants';
import { createNoise3, type Noise3 } from '../core/noise';
import type { Rng } from '../core/rng';
import type { Vec3 } from '../core/types';
import {
  RIFT_MIN_AREA, RIFT_MIN_SHARE, RIFT_REF_PLATES, RIFT_SIZE_FACTOR_MAX, RIFT_SIZE_FACTOR_MIN, RIFT_SPEED_MAX,
  RIFT_SPEED_MIN, RIFT_WARP, RIFT_WARP_FREQ,
} from './simConstants';
import { splitPlate } from './simSplit';
import { plateCap, type PlateSlot, type SimState } from './simState';

/**
 * I. Poisson rifting (riftRate events per 100 Myr for a world of RIFT_REF_PLATES equal plates, more when
 * plates are larger, see sizeFactor; only below the plate cap): a plate chosen with
 * weight area × (1 + continental fraction) splits along a noise-warped bisector between two
 * far-apart seeds; the halves get ω ∓ Δω/2 so they separate at 20–60 km/Myr.
 * Returns true when a rift happened.
 */
export function maybeRift(state: SimState, rng: Rng, dt: number): boolean {
  const rate = state.params.riftRate;
  if (!(rate > 0)) return false;
  const roll = rng.next();
  let live = 0, sumA2 = 0;
  for (const p of state.slots) {
    if (!p) continue;
    live++;
    const a = p.visible / state.n;
    sumA2 += a * a;
  }
  if (live >= plateCap(state)) return false;
  // Large plates break up more readily (a supercontinent insulates the mantle beneath it): the rate
  // scales with Σ A_k² (area-weighted mean plate size), relative to RIFT_REF_PLATES equal plates, so
  // a world that has welded into a few large plates starts rifting again (plate count self-regulates).
  const sizeFactor = Math.min(RIFT_SIZE_FACTOR_MAX, Math.max(RIFT_SIZE_FACTOR_MIN, sumA2 * RIFT_REF_PLATES));
  if (roll >= 1 - Math.exp((-rate * sizeFactor * dt) / 100)) return false;
  const minCells = RIFT_MIN_AREA * state.n;
  let total = 0;
  const weights: Array<[number, number]> = [];
  for (const p of state.slots) {
    if (!p || p.visible < minCells) continue;
    const w = p.visible * (1 + p.visibleCont / p.visible);
    weights.push([p.slot, w]);
    total += w;
  }
  if (total <= 0) return false;
  let pick = rng.next() * total;
  let parent = weights[weights.length - 1][0];
  for (const [slot, w] of weights) {
    pick -= w;
    if (pick < 0) {
      parent = slot;
      break;
    }
  }
  return riftPlate(state, parent, rng);
}

/** Visible world cell of plate k farthest (by angle) from unit vector (x, y, z). */
function farthestVisible(state: SimState, k: number, x: number, y: number, z: number): number {
  const { top, n } = state;
  const { xyz } = state.sm;
  let best = -1, bestDot = Infinity;
  for (let i = 0; i < n; i++) {
    if (top[i] !== k) continue;
    const d = xyz[3 * i] * x + xyz[3 * i + 1] * y + xyz[3 * i + 2] * z;
    if (d < bestDot) {
      bestDot = d;
      best = i;
    }
  }
  return best;
}

function toPlate(P: PlateSlot, v: Vec3): Vec3 {
  const m = P.m;
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

function riftPlate(state: SimState, parentSlot: number, rng: Rng): boolean {
  const P = state.slots[parentSlot] as PlateSlot;
  const { n } = state;
  const { xyz } = state.sm;
  // Two far-apart seeds: random visible cell → farthest A → farthest from A = B.
  const start = farthestVisible(state, parentSlot, ...rng.unitVector());
  if (start < 0) return false;
  const iA = farthestVisible(state, parentSlot, xyz[3 * start], xyz[3 * start + 1], xyz[3 * start + 2]);
  const iB = farthestVisible(state, parentSlot, xyz[3 * iA], xyz[3 * iA + 1], xyz[3 * iA + 2]);
  const A: Vec3 = [xyz[3 * iA], xyz[3 * iA + 1], xyz[3 * iA + 2]];
  const B: Vec3 = [xyz[3 * iB], xyz[3 * iB + 1], xyz[3 * iB + 2]];
  const a = toPlate(P, A), b = toPlate(P, B);
  const noiseSeed = (state.params.seed * 7919 + state.stepIndex * 104729 + 13) >>> 0;
  const nx: Noise3 = createNoise3(noiseSeed), ny = createNoise3(noiseSeed + 1), nz = createNoise3(noiseSeed + 2);
  const side = new Uint8Array(n);
  let countB = 0;
  const f = RIFT_WARP_FREQ;
  for (let j = 0; j < n; j++) {
    if (!P.owned[j]) continue;
    const x = xyz[3 * j], y = xyz[3 * j + 1], z = xyz[3 * j + 2];
    const wx = x + RIFT_WARP * nx(x * f, y * f, z * f);
    const wy = y + RIFT_WARP * ny(x * f, y * f, z * f);
    const wz = z + RIFT_WARP * nz(x * f, y * f, z * f);
    if (wx * b[0] + wy * b[1] + wz * b[2] > wx * a[0] + wy * a[1] + wz * a[2]) {
      side[j] = 1;
      countB++;
    }
  }
  const minShare = RIFT_MIN_SHARE * P.ownedCount;
  if (countB < minShare || P.ownedCount - countB < minShare) return false;

  // Separation: rotation about A×B moves A toward B, so the B half gets +Δω/2.
  let ax = A[1] * B[2] - A[2] * B[1], ay = A[2] * B[0] - A[0] * B[2], az = A[0] * B[1] - A[1] * B[0];
  let al = Math.hypot(ax, ay, az);
  if (al < 1e-6) {
    // Antipodal seeds: any axis perpendicular to A works.
    ax = -A[1];
    ay = A[0];
    az = 0;
    al = Math.hypot(ax, ay);
    if (al < 1e-6) {
      ax = 1;
      ay = 0;
      al = 1;
    }
  }
  const half = (0.5 * rng.float(RIFT_SPEED_MIN, RIFT_SPEED_MAX)) / EARTH_RADIUS_KM / al;
  const dw: Vec3 = [ax * half, ay * half, az * half];
  if (splitPlate(state, parentSlot, side, countB, [-dw[0], -dw[1], -dw[2]], dw, 'above') < 0) return false;
  state.counters.rifts++;
  return true;
}
