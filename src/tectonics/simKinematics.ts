import { quatFromAxisAngle, quatMul } from '../core/math3';
import { nearestCell } from '../core/sphereMesh';
import { CRUST_CONTINENTAL } from '../core/types';
import {
  COLLISION_THICKNESS_PROXY, CONSUME_MIN_VCONV, MAX_SUBSTEPS, SUBSTEP_MAX_DISPLACEMENT,
} from './simConstants';
import { dirtySet, markReleased, markTopChanged, settleDebug } from './simDirty';
import { fillGaps, markOrphanedTops } from './simGaps';
import { convergenceAt } from './simGeometry';
import { walkFrom } from './simMesh';
import { profLap, profStart } from './simProfile';
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

/**
 * Steps A–D for one substep of dtSub Myr. `deep` (intermediate substeps of a multi-substep step
 * only, see markDeepInterior): world cells flagged 0 there are skipped by the world pass, and plate
 * cells pushing into them by the plate pass. Nothing can change for them before the step's last
 * substep, which runs in full, so the step's result is exactly the same as without skipping.
 */
export function runSubstep(state: SimState, dtSub: number, deep: Uint8Array | null = null): void {
  let t = profStart();
  movePlates(state, dtSub);
  beginSubstep(state);
  t = profLap('A.move', t);
  worldPass(state, deep);
  t = profLap('B.worldPass', t);
  platePass(state, deep);
  t = profLap('C.platePass', t);
  settleTops(state, false);
  profLap('D.settle', t);
}

/** Per-state scratch of the interior mask. */
interface InteriorScratch {
  /** 0 = deep interior; r + 1 = within r rings of a cell where anything can happen this step. */
  near: Uint8Array;
  queue: Int32Array;
}
const interiorOf = new WeakMap<SimState, InteriorScratch>();

/**
 * Before a step of `substeps` > 1 substeps: flag (near[i] = 0) world cells deep inside their top
 * plate — farther than the step's largest plate displacement plus a safety margin (in lattice rings)
 * from every cell that has another top plate in its ring, a loser, another plate's presence, or an
 * unowned lattice cell of its top plate next to the one it shows (interior lattice hole). Plate
 * edges and holes move at most that far during the step, so such a cell stays covered by the same
 * plate, alone, with only its source lattice cell changing; that is computed once, in the last substep.
 * Returns the mask (0 = skippable) or null when nothing may be skipped.
 */
export function markDeepInterior(state: SimState, dt: number, substeps: number): Uint8Array | null {
  if (substeps < 2 || settleDebug.noDeepSkip) return null;
  let maxW = 0;
  for (const p of state.slots) {
    if (!p) continue;
    const w = p.spec.omega;
    maxW = Math.max(maxW, Math.hypot(w[0], w[1], w[2]));
  }
  // Displacement over the whole step in cell spacings; a ring hop can be as short as ~0.7 spacing on
  // the Fibonacci lattice, and the passes look up to 3 rings around a cell (boundary normals).
  const disp = (maxW * dt * Math.abs(state.params.speedScale)) / state.sm.mesh.spacing;
  const reach = Math.ceil(1.5 * disp) + 5;
  if (reach > 250) return null;
  let sc = interiorOf.get(state);
  if (!sc) {
    sc = { near: new Uint8Array(state.n), queue: new Int32Array(state.n) };
    interiorOf.set(state, sc);
  }
  const { near, queue } = sc;
  const { n, top, src, slots, loser, presenceCur } = state;
  const { adjOffset, adj } = state.sm;
  near.fill(0);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const t = top[i];
    let seed = loser[i] !== 0 || (presenceCur[i] & ~(1 << t)) !== 0;
    if (!seed) {
      for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
        if (top[adj[q]] !== t) {
          seed = true;
          break;
        }
      }
    }
    if (!seed) {
      // An unowned lattice cell next to the one shown here (an interior lattice hole, left by a
      // merge, terrane transfer or speck hand-over that no world cell maps onto yet) opens as a gap
      // wherever it surfaces during the step; the full passes fill it in the first substep it
      // shows, so its surroundings must not be skipped either.
      const owned = (slots[t] as PlateSlot).owned;
      const j = src[i];
      if (!owned[j]) seed = true;
      for (let q = adjOffset[j], e = adjOffset[j + 1]; q < e && !seed; q++) {
        if (!owned[adj[q]]) {
          seed = true;
          break;
        }
      }
    }
    if (seed) {
      near[i] = 1;
      queue[tail++] = i;
    }
  }
  for (let head = 0; head < tail; head++) {
    const c = queue[head];
    const r = near[c];
    if (r > reach) continue;
    for (let q = adjOffset[c], e = adjOffset[c + 1]; q < e; q++) {
      const a = adj[q];
      if (near[a] === 0) {
        near[a] = r + 1;
        queue[tail++] = a;
      }
    }
  }
  return near;
}

/**
 * D (+ cleanup). Make the top map consistent after lattice edits: hand isolated specks to their
 * surroundings, then refill world cells nobody covers (gaps and cells whose covering lattice cell
 * disappeared). Repeats while that could have produced new specks (speck hand-overs, or a refilled
 * cell that is itself isolated); one round suffices in the vast majority of substeps.
 */
export function settleTops(state: SimState, full = true): void {
  const dirty = dirtySet(state);
  for (let round = 0; round < 4; round++) {
    // The first round scans every cell after untracked edits; otherwise only changed neighbourhoods.
    const scanAll = settleDebug.fullScans || (round === 0 && (full || dirty.full));
    if (scanAll) dirty.full = false;
    let t = profStart();
    const handedOver = resolveSpecks(state, scanAll);
    t = profLap('D1.specks', t);
    markOrphanedTops(state, scanAll);
    t = profLap('D2.orphans', t);
    const newSpeck = fillGaps(state);
    profLap('D3.fillGaps', t);
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
function worldPass(state: SimState, deep: Uint8Array | null): void {
  const { n, top, topPrev, src, loser, presencePrev, slots, rankPos, gaps } = state;
  const sm = state.sm;
  const { xyz, adjOffset, adj, mesh } = sm;
  const liveMask = state.liveMask;
  let gapCount = 0;
  for (let i = 0; i < n; i++) {
    if (deep !== null && deep[i] === 0) continue;
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
      const j = h >= 0 ? walkFrom(sm, lx, ly, lz, h) : nearestCell(mesh, lx, ly, lz);
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
      if (tp >= 0) markTopChanged(state, i);
      continue;
    }
    top[i] = best;
    src[i] = bestJ;
    loser[i] = cover & ~(1 << best);
    if (best !== tp) markTopChanged(state, i);
  }
  state.gapCount = gapCount;
}

/**
 * C. Plate pass (push): map every owned lattice cell to the world, record presence / push data, and
 * consume cells buried under another plate where the plates converge (v_conv gate, smooth normal).
 */
function platePass(state: SimState, deep: Uint8Array | null): void {
  const { n, top, presenceCur, slots } = state;
  const sm = state.sm;
  const { xyz, adjOffset, adj } = sm;
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
      if (deep !== null && deep[hint[j]] === 0) continue;
      const x = xyz[3 * j], y = xyz[3 * j + 1], z = xyz[3 * j + 2];
      const wx = m[0] * x + m[1] * y + m[2] * z;
      const wy = m[3] * x + m[4] * y + m[5] * z;
      const wz = m[6] * x + m[7] * y + m[8] * z;
      const i = walkFrom(sm, wx, wy, wz, hint[j]);
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
  markReleased(state, i);
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
