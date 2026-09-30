import { EARTH_RADIUS_KM } from '../core/constants';
import { CRUST_CONTINENTAL } from '../core/types';
import {
  CONSUME_MIN_VCONV, FRONT_SMOOTH_PASSES, SLAB_PULL_SPEED,
} from './simConstants';
import { convergenceAt, kin } from './simGeometry';
import { FRONT_COLLISION, FRONT_NONE, FRONT_SUBDUCTION, stepScratch, type StepScratch } from './simScratch';
import { pairIndex, type PlateSlot, type SimState } from './simState';

/**
 * Refresh the raw world fields (top plate's lattice values) and per-plate visible counts.
 * Called after the substeps and after any discrete plate edit.
 */
export function buildWorldFields(state: SimState): void {
  const sc = stepScratch(state);
  const { n, top, src, slots, wElev, wCrust } = state;
  for (const p of slots) {
    if (!p) continue;
    p.visible = 0;
    p.visibleCont = 0;
  }
  for (let i = 0; i < n; i++) {
    const P = slots[top[i]] as PlateSlot;
    const j = src[i];
    wElev[i] = P.elev[j];
    wCrust[i] = P.crust[j];
    sc.wAge[i] = P.age[j];
    P.visible++;
    if (P.crust[j] === CRUST_CONTINENTAL) P.visibleCont++;
  }
}

/** Does the top plate T at a contact override plate K? Continental beats oceanic, else polarity rank. */
function overrides(state: SimState, T: number, crustT: number, K: number, crustK: number): boolean {
  if (crustT !== crustK) return crustT > crustK;
  return state.rankPos[T] > state.rankPos[K];
}

/**
 * E (part 1). Detect subduction and collision fronts from the persistent boundary geometry: a front
 * is a top-plate cell next to a plate K that goes under it at the contact, converging faster than
 * CONSUME_MIN_VCONV (smooth 3-ring boundary normal). Also fills per-plate perimeters, collision
 * contacts per plate pair and the slab-pull accumulators.
 */
export function detectFronts(state: SimState): StepScratch {
  const sc = stepScratch(state);
  const { n, top, wCrust, pairs } = state;
  const { xyz, adjOffset, adj } = state.sm;
  const { frontV, frontKind, frontOver, frontUnder, frontN, frontList } = sc;
  for (let q = 0; q < sc.frontCount; q++) {
    const i = frontList[q];
    frontV[i] = 0;
    frontKind[i] = FRONT_NONE;
    frontOver[i] = -1;
    frontUnder[i] = -1;
  }
  sc.frontCount = 0;
  sc.boundaryCells.fill(0);
  sc.slabA.fill(0);
  sc.slabB.fill(0);
  sc.slabCells.fill(0);
  sc.contactSum.fill(0);
  pairs.contacts.fill(0);
  pairs.vconvSum.fill(0);

  for (let i = 0; i < n; i++) {
    const T = top[i];
    let handled = 0;
    let boundary = false;
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
      const a = adj[q];
      const K = top[a];
      if (K === T) continue;
      boundary = true;
      if ((handled >>> K) & 1) continue;
      handled |= 1 << K;
      if (!overrides(state, T, wCrust[i], K, wCrust[a])) continue;
      const v = convergenceAt(state, i, K, T);
      if (v <= CONSUME_MIN_VCONV || v <= frontV[i]) continue;
      if (frontV[i] === 0) frontList[sc.frontCount++] = i;
      frontV[i] = v;
      frontKind[i] = wCrust[i] === CRUST_CONTINENTAL && wCrust[a] === CRUST_CONTINENTAL ? FRONT_COLLISION : FRONT_SUBDUCTION;
      frontOver[i] = T;
      frontUnder[i] = K;
      frontN[3 * i] = kin[0];
      frontN[3 * i + 1] = kin[1];
      frontN[3 * i + 2] = kin[2];
    }
    if (boundary) sc.boundaryCells[T]++;
  }
  smoothFrontSpeeds(state, sc);

  for (let q = 0; q < sc.frontCount; q++) {
    const i = frontList[q];
    const T = frontOver[i], K = frontUnder[i];
    if (frontKind[i] === FRONT_COLLISION) {
      const pi = pairIndex(T, K);
      pairs.contacts[pi]++;
      pairs.vconvSum[pi] += frontV[i];
      sc.contactSum[3 * pi] += xyz[3 * i];
      sc.contactSum[3 * pi + 1] += xyz[3 * i + 1];
      sc.contactSum[3 * pi + 2] += xyz[3 * i + 2];
    } else {
      // Slab pull drags the subducting plate toward the trench (−n̂): accumulate the least-squares
      // system Σ(I − p pᵀ) ω = Σ p × v_target for plate K.
      const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
      const s = -SLAB_PULL_SPEED / EARTH_RADIUS_KM;
      const vx = frontN[3 * i] * s, vy = frontN[3 * i + 1] * s, vz = frontN[3 * i + 2] * s;
      const A = sc.slabA, B = sc.slabB, o = 9 * K;
      A[o] += 1 - px * px; A[o + 1] -= px * py; A[o + 2] -= px * pz;
      A[o + 3] -= py * px; A[o + 4] += 1 - py * py; A[o + 5] -= py * pz;
      A[o + 6] -= pz * px; A[o + 7] -= pz * py; A[o + 8] += 1 - pz * pz;
      B[3 * K] += py * vz - pz * vy;
      B[3 * K + 1] += pz * vx - px * vz;
      B[3 * K + 2] += px * vy - py * vx;
      sc.slabCells[K]++;
    }
  }
  return sc;
}

/** Average front speeds along each front (same overriding/subducting pair) to remove normal noise. */
function smoothFrontSpeeds(state: SimState, sc: StepScratch): void {
  const { adjOffset, adj } = state.sm;
  const { frontV, frontOver, frontUnder, frontList, tmpA } = sc;
  for (let pass = 0; pass < FRONT_SMOOTH_PASSES; pass++) {
    for (let q = 0; q < sc.frontCount; q++) {
      const i = frontList[q];
      let sum = frontV[i], cnt = 1;
      for (let r = adjOffset[i], e = adjOffset[i + 1]; r < e; r++) {
        const a = adj[r];
        if (frontV[a] > 0 && frontOver[a] === frontOver[i] && frontUnder[a] === frontUnder[i]) {
          sum += frontV[a];
          cnt++;
        }
      }
      tmpA[i] = sum / cnt;
    }
    for (let q = 0; q < sc.frontCount; q++) frontV[frontList[q]] = tmpA[frontList[q]];
  }
}
