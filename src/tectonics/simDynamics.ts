import { EARTH_RADIUS_KM, MAX_PLATES } from '../core/constants';
import type { Vec3 } from '../core/types';
import {
  COLLISION_DRAG, COLLISION_MEMORY, COLLISION_SHORTENING_REF, MAX_SURFACE_SPEED, MERGE_SPEED, MERGE_TIME,
  SLAB_PULL_FULL_FRACTION, SLAB_PULL_INTERVAL, SLAB_PULL_TAU,
} from './simConstants';
import { relativeSpeed } from './simGeometry';
import { mergePlates } from './simMerge';
import type { StepScratch } from './simScratch';
import { pairIndex, type PlateSlot, type SimState } from './simState';

/**
 * H. Plate dynamics: collision resistance (pairwise relaxation toward the area-weighted mean ω,
 * growing with accumulated shortening), merging of welded plates, slow slab-pull refit and the
 * maximum-speed clamp.
 */
export function plateDynamics(state: SimState, sc: StepScratch, dt: number): void {
  collisionDrag(state, sc, dt);
  if (state.params.mergePlates) mergeWeldedPairs(state, dt);
  slabPull(state, sc);
  clampSpeeds(state);
}

/**
 * ω_x ← ω̄ + (ω_x − ω̄)·exp(−κ·L·dt/A_x) with κ = COLLISION_DRAG·(S/S_ref)², L the collision front
 * length and A_x the plate area: unconditionally stable and momentum-weighted, so convergence stops
 * after roughly S_ref of shortening.
 */
function collisionDrag(state: SimState, sc: StepScratch, dt: number): void {
  const { pairs, slots } = state;
  const { spacingKm, cellAreaKm2 } = state.sm;
  for (let a = 0; a < MAX_PLATES; a++) {
    const Pa = slots[a];
    if (!Pa) continue;
    for (let b = a + 1; b < MAX_PLATES; b++) {
      const Pb = slots[b];
      if (!Pb) continue;
      const pi = pairIndex(a, b);
      const contacts = pairs.contacts[pi];
      if (contacts > 0) {
        const cx = sc.contactSum[3 * pi], cy = sc.contactSum[3 * pi + 1], cz = sc.contactSum[3 * pi + 2];
        const cl = Math.hypot(cx, cy, cz);
        if (cl > 0) {
          pairs.contactPoint[3 * pi] = cx / cl;
          pairs.contactPoint[3 * pi + 1] = cy / cl;
          pairs.contactPoint[3 * pi + 2] = cz / cl;
        }
        pairs.shortening[pi] += (pairs.vconvSum[pi] / contacts) * dt;
        pairs.sinceContact[pi] = 0;
        const s = pairs.shortening[pi] / COLLISION_SHORTENING_REF;
        const kappa = COLLISION_DRAG * s * s;
        const L = contacts * spacingKm;
        const Aa = Math.max(1, Pa.visible) * cellAreaKm2;
        const Ab = Math.max(1, Pb.visible) * cellAreaKm2;
        relaxPair(Pa, Pb, Aa, Ab, Math.exp((-kappa * L * dt) / Aa), Math.exp((-kappa * L * dt) / Ab));
      } else if (pairs.shortening[pi] > 0) {
        pairs.sinceContact[pi] += dt;
        if (pairs.sinceContact[pi] > COLLISION_MEMORY) {
          pairs.shortening[pi] = 0;
          pairs.slowTime[pi] = 0;
        }
      }
    }
  }
}

function relaxPair(Pa: PlateSlot, Pb: PlateSlot, Aa: number, Ab: number, fa: number, fb: number): void {
  const wa = Pa.spec.omega, wb = Pb.spec.omega;
  const mean: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) mean[c] = (Aa * wa[c] + Ab * wb[c]) / (Aa + Ab);
  Pa.spec.omega = [mean[0] + (wa[0] - mean[0]) * fa, mean[1] + (wa[1] - mean[1]) * fa, mean[2] + (wa[2] - mean[2]) * fa];
  Pb.spec.omega = [mean[0] + (wb[0] - mean[0]) * fb, mean[1] + (wb[1] - mean[1]) * fb, mean[2] + (wb[2] - mean[2]) * fb];
}

/** Count world cells of plate a that touch plate b. */
function sharedBoundary(state: SimState, a: number, b: number): number {
  const { n, top } = state;
  const { adjOffset, adj } = state.sm;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (top[i] !== a) continue;
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
      if (top[adj[q]] === b) {
        cnt++;
        break;
      }
    }
  }
  return cnt;
}

/** Merge collided pairs whose relative speed at the suture stayed < MERGE_SPEED for MERGE_TIME. */
function mergeWeldedPairs(state: SimState, dt: number): void {
  const { pairs } = state;
  for (let a = 0; a < MAX_PLATES; a++) {
    for (let b = a + 1; b < MAX_PLATES; b++) {
      const Pa = state.slots[a], Pb = state.slots[b];
      if (!Pa || !Pb) continue;
      const pi = pairIndex(a, b);
      if (!(pairs.shortening[pi] > 0)) continue;
      const cp = pairs.contactPoint;
      const rel = relativeSpeed(Pa, Pb, cp[3 * pi], cp[3 * pi + 1], cp[3 * pi + 2]);
      if (rel >= MERGE_SPEED) {
        pairs.slowTime[pi] = 0;
        continue;
      }
      pairs.slowTime[pi] += dt;
      if (pairs.slowTime[pi] < MERGE_TIME) continue;
      if (sharedBoundary(state, a, b) === 0) {
        pairs.slowTime[pi] = 0;
        continue;
      }
      const [small, large] = Pa.visible < Pb.visible ? [a, b] : [b, a];
      mergePlates(state, small, large);
      (state.slots[large] as PlateSlot).visible += (small === a ? Pa : Pb).visible;
    }
  }
}

/** Solve the 3×3 system (row-major A) · x = b; returns null when singular. */
function solve3(A: Float64Array, o: number, b0: number, b1: number, b2: number): Vec3 | null {
  const a = A[o], b = A[o + 1], c = A[o + 2];
  const d = A[o + 3], e = A[o + 4], f = A[o + 5];
  const g = A[o + 6], h = A[o + 7], k = A[o + 8];
  const c0 = e * k - f * h, c1 = f * g - d * k, c2 = d * h - e * g;
  const det = a * c0 + b * c1 + c * c2;
  if (!(Math.abs(det) > 1e-12)) return null;
  const inv = 1 / det;
  return [
    (b0 * c0 + b1 * (c * h - b * k) + b2 * (b * f - c * e)) * inv,
    (b0 * c1 + b1 * (a * k - c * g) + b2 * (c * d - a * f)) * inv,
    (b0 * c2 + b1 * (b * g - a * h) + b2 * (a * e - b * d)) * inv,
  ];
}

const regA = new Float64Array(9);

/**
 * Every SLAB_PULL_INTERVAL Myr relax each subducting plate's ω toward the least-squares rotation
 * that moves its trench cells toward their trenches (weighted by the subducting share of its
 * perimeter), so Euler poles slowly reorganize.
 */
function slabPull(state: SimState, sc: StepScratch): void {
  const elapsed = state.time - state.lastSlabPullTime;
  if (elapsed < SLAB_PULL_INTERVAL) return;
  state.lastSlabPullTime = state.time;
  const f = 1 - Math.exp(-elapsed / SLAB_PULL_TAU);
  for (let k = 0; k < MAX_PLATES; k++) {
    const P = state.slots[k];
    const cells = sc.slabCells[k];
    if (!P || cells === 0) continue;
    // Tikhonov term λ|ω − ω_current|² keeps unconstrained components (short trenches) unchanged.
    const lambda = 0.05 * cells;
    for (let c = 0; c < 9; c++) regA[c] = sc.slabA[9 * k + c] + (c % 4 === 0 ? lambda : 0);
    const w = P.spec.omega;
    const fit = solve3(regA, 0, sc.slabB[3 * k] + lambda * w[0], sc.slabB[3 * k + 1] + lambda * w[1], sc.slabB[3 * k + 2] + lambda * w[2]);
    if (!fit || !fit.every(Number.isFinite)) continue;
    const weight = Math.min(1, cells / (SLAB_PULL_FULL_FRACTION * Math.max(1, sc.boundaryCells[k])));
    const g = weight * f;
    P.spec.omega = [w[0] + (fit[0] - w[0]) * g, w[1] + (fit[1] - w[1]) * g, w[2] + (fit[2] - w[2]) * g];
  }
}

/** |ω|·R ≤ MAX_SURFACE_SPEED (the fastest point of the rotation). */
export function clampSpeeds(state: SimState): void {
  const maxW = MAX_SURFACE_SPEED / EARTH_RADIUS_KM;
  for (const P of state.slots) {
    if (!P) continue;
    const w = P.spec.omega;
    const mag = Math.hypot(w[0], w[1], w[2]);
    if (mag > maxW) {
      const s = maxW / mag;
      P.spec.omega = [w[0] * s, w[1] * s, w[2] * s];
    }
  }
}
