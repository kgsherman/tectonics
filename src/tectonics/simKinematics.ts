import { quatFromAxisAngle, quatMul } from '../core/math3';
import { nearestCell } from '../core/sphereMesh';
import { CRUST_CONTINENTAL } from '../core/types';
import {
  COLLISION_THICKNESS_PROXY, CONSUME_MIN_VCONV, MAX_SUBSTEPS, SUBSTEP_MAX_DISPLACEMENT,
} from './simConstants';
import { fillGaps, markOrphanedTops } from './simGaps';
import { convergenceAt } from './simGeometry';
import { walkNearest } from './simMesh';
import { resolveSpecks } from './simSpecks';
import { setPlateRotation, slotBit, type PlateSlot, type SimState } from './simState';

/** Per-state cache of convergence speeds evaluated in the current plate pass. */
interface ConvergenceCache {
  stamp: Int32Array;
  plate: Int8Array;
  value: Float32Array;
}
const cacheOf = new WeakMap<SimState, ConvergenceCache>();
function convergenceCache(state: SimState): ConvergenceCache {
  let c = cacheOf.get(state);
  if (!c) {
    c = { stamp: new Int32Array(state.n).fill(-1), plate: new Int8Array(state.n), value: new Float32Array(state.n) };
    cacheOf.set(state, c);
  }
  return c;
}

/** Number of substeps so no plate point moves more than SUBSTEP_MAX_DISPLACEMENT cells per substep. */
export function substepCount(state: SimState, dt: number): { count: number; capped: boolean } {
  let maxW = 0;
  for (const p of state.slots) {
    if (!p) continue;
    const w = p.spec.omega;
    maxW = Math.max(maxW, Math.hypot(w[0], w[1], w[2]));
  }
  const need = Math.ceil((maxW * dt * Math.abs(state.params.speedScale)) / (SUBSTEP_MAX_DISPLACEMENT * state.sm.mesh.spacing));
  const count = Math.min(MAX_SUBSTEPS, Math.max(1, need));
  return { count, capped: need > MAX_SUBSTEPS };
}

/** Steps A–D for one substep of dtSub Myr. */
export function runSubstep(state: SimState, dtSub: number): void {
  movePlates(state, dtSub);
  beginSubstep(state);
  worldPass(state);
  platePass(state);
  settleTops(state);
}

/**
 * D (+ cleanup). Make the top map consistent after lattice edits: hand isolated specks to their
 * surroundings, then refill world cells nobody covers (gaps and cells whose covering lattice cell
 * disappeared). Repeats while that could have produced new specks (speck hand-overs, or a refilled
 * cell that is itself isolated); one round suffices in the vast majority of substeps.
 */
export function settleTops(state: SimState): void {
  for (let round = 0; round < 4; round++) {
    const handedOver = resolveSpecks(state);
    markOrphanedTops(state);
    const newSpeck = fillGaps(state);
    if (handedOver === 0 && !newSpeck) return;
  }
}

/** A. Rotate every plate: q ← quat(ω̂, |ω|·dt·speedScale) ⊗ q. */
function movePlates(state: SimState, dtSub: number): void {
  const scale = state.params.speedScale;
  for (const p of state.slots) {
    if (!p) continue;
    const w = p.spec.omega;
    const mag = Math.hypot(w[0], w[1], w[2]);
    if (!(mag > 0)) continue;
    setPlateRotation(p, quatMul(quatFromAxisAngle(w, mag * dtSub * scale), p.q));
  }
}

function beginSubstep(state: SimState): void {
  state.topPrev.set(state.top);
  const t = state.presencePrev;
  state.presencePrev = state.presenceCur;
  state.presenceCur = t;
  t.fill(0);
  state.substepSerial++;
}

/**
 * B. World pass (pull): for every world cell find which plates cover it. Candidates are the previous
 * top plus the plates whose lattice cells pushed into the cell or its ring last substep (presence).
 * Top = continental over oceanic per cell, otherwise the higher polarity rank; the others are losers.
 */
function worldPass(state: SimState): void {
  const { n, top, topPrev, src, loser, presencePrev, slots, rankPos, gaps } = state;
  const { xyz, adjOffset, adj, mesh } = state.sm;
  const liveMask = state.liveMask;
  let gapCount = 0;
  for (let i = 0; i < n; i++) {
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    const tp = topPrev[i];
    const a0 = adjOffset[i], a1 = adjOffset[i + 1];
    let cand = presencePrev[i];
    for (let q = a0; q < a1; q++) cand |= presencePrev[adj[q]];
    if (tp >= 0) cand |= 1 << tp;
    cand &= liveMask;
    if (cand === 0) cand = liveMask;
    let best = -1, bestJ = -1, bestCont = -1, bestRank = -1, cover = 0;
    while (cand !== 0) {
      const low = cand & -cand;
      cand ^= low;
      const k = 31 - Math.clz32(low);
      const P = slots[k] as PlateSlot;
      const m = P.m;
      const lx = m[0] * x + m[3] * y + m[6] * z;
      const ly = m[1] * x + m[4] * y + m[7] * z;
      const lz = m[2] * x + m[5] * y + m[8] * z;
      // Walk hint: the lattice cell that pushed here (or next door) last substep, else last top.
      let h = -1;
      if ((presencePrev[i] >>> k) & 1) h = P.pushInv[i];
      else if (tp === k) h = src[i];
      else {
        for (let q = a0; q < a1; q++) {
          const a = adj[q];
          if ((presencePrev[a] >>> k) & 1) {
            h = P.pushInv[a];
            break;
          }
        }
      }
      const j = h >= 0 ? walkNearest(xyz, adjOffset, adj, lx, ly, lz, h) : nearestCell(mesh, lx, ly, lz);
      if (!P.owned[j]) continue;
      cover |= low;
      const cont = P.crust[j];
      const r = rankPos[k];
      if (best < 0 || cont > bestCont || (cont === bestCont && r > bestRank)) {
        best = k;
        bestJ = j;
        bestCont = cont;
        bestRank = r;
      }
    }
    if (best < 0) {
      top[i] = -1;
      loser[i] = 0;
      gaps[gapCount++] = i;
      continue;
    }
    top[i] = best;
    src[i] = bestJ;
    loser[i] = cover & ~(1 << best);
  }
  state.gapCount = gapCount;
}

/**
 * C. Plate pass (push): map every owned lattice cell to the world, record presence / push data, and
 * consume cells buried under another plate where the plates converge (v_conv gate, smooth normal).
 */
function platePass(state: SimState): void {
  const { n, top, presenceCur, slots } = state;
  const { xyz, adjOffset, adj } = state.sm;
  const cache = convergenceCache(state);
  for (let k = 0; k < slots.length; k++) {
    const P = slots[k];
    if (!P) continue;
    const { owned, owned4, hint, pushInv, m } = P;
    const bit = slotBit(k);
    for (let j = 0; j < n; j++) {
      if ((j & 3) === 0 && owned4[j >> 2] === 0) {
        j += 3;
        continue;
      }
      if (!owned[j]) continue;
      const x = xyz[3 * j], y = xyz[3 * j + 1], z = xyz[3 * j + 2];
      const wx = m[0] * x + m[1] * y + m[2] * z;
      const wy = m[3] * x + m[4] * y + m[5] * z;
      const wz = m[6] * x + m[7] * y + m[8] * z;
      const i = walkNearest(xyz, adjOffset, adj, wx, wy, wz, hint[j]);
      hint[j] = i;
      presenceCur[i] |= bit;
      pushInv[i] = j;
      const t = top[i];
      if (t === k || t < 0) continue;
      // Losers and buried orphans are consumption candidates alike, but only once at least one cell
      // under the top plate (no ring neighbour still shows plate k): consuming at the very edge would
      // uncover world cells still pulled from this lattice cell, which would then be refilled from the
      // same plate (crust recycled instead of consumed). Edge aliases are left alone.
      let edge = false;
      for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
        if (top[adj[q]] === k) {
          edge = true;
          break;
        }
      }
      if (edge) continue;
      let v: number;
      if (cache.stamp[i] === state.substepSerial && cache.plate[i] === k) v = cache.value[i];
      else {
        // Buried beyond the normal's reach (no cell of plate k on top within the 3-ring disk): only
        // overriding gets crust that deep (transform aliasing bands are one cell wide), so it is a
        // slab remnant and is consumed; otherwise the convergence gate decides.
        v = buriedDeep(state, i, k) ? Infinity : convergenceAt(state, i, k, t);
        cache.stamp[i] = state.substepSerial;
        cache.plate[i] = k;
        cache.value[i] = v;
      }
      if (v > CONSUME_MIN_VCONV) consumeCell(state, P, j, i);
    }
  }
}

/** True when no cell of the 3-ring disk around world cell i has plate k on top. */
function buriedDeep(state: SimState, i: number, k: number): boolean {
  const { diskOffset, disk } = state.sm;
  const top = state.top;
  for (let q = diskOffset[i], e = diskOffset[i + 1]; q < e; q++) if (top[disk[q]] === k) return false;
  return true;
}

/** Remove lattice cell j of plate P consumed at world cell i (subduction or collision). */
function consumeCell(state: SimState, P: PlateSlot, j: number, i: number): void {
  P.owned[j] = 0;
  P.ownedCount--;
  if (P.crust[j] === CRUST_CONTINENTAL) {
    // Continental crust cannot sink: its volume feeds the collision belt at this front.
    const vol = Math.max(0, P.elev[j] + 500) + COLLISION_THICKNESS_PROXY;
    if (state.collisionBudget[i] === 0) state.budgetCells[state.budgetCount++] = i;
    state.collisionBudget[i] += vol;
    state.counters.continentalDestroyed++;
    state.counters.collisionConsumed++;
  } else {
    state.counters.subductedCells++;
  }
}
