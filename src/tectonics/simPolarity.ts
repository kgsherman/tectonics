import { MAX_PLATES } from '../core/constants';
import { CRUST_OCEANIC } from '../core/types';
import {
  CONTINENTAL_RANK_BONUS, POLARITY_BAND_KM, POLARITY_DEFAULT_AGE, POLARITY_FLIP_DIFF, POLARITY_FLIP_TIME,
  POLARITY_INTERVAL,
} from './simConstants';
import { stepScratch } from './simScratch';
import { liveSlotList, refreshRankPositions, type PlateSlot, type SimState } from './simState';

const scores = new Float64Array(MAX_PLATES);
const sumAge = new Float64Array(MAX_PLATES);
const cntAge = new Float64Array(MAX_PLATES);

/**
 * Buoyancy score per plate slot (higher = more buoyant = overrides): minus the mean age of the
 * plate's oceanic crust within POLARITY_BAND_KM of its boundaries (ring BFS inside each plate from
 * its boundary cells), plus a bonus for continent-dominated plates. Requires fresh world fields.
 */
function computeScores(state: SimState): Float64Array {
  const sc = stepScratch(state);
  const { n, top, wCrust, slots } = state;
  const { adjOffset, adj, spacingKm } = state.sm;
  const queue = sc.sources;
  const ring = sc.ring;
  ring.fill(-1);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const t = top[i];
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
      if (top[adj[q]] !== t) {
        queue[tail++] = i;
        ring[i] = 0;
        break;
      }
    }
  }
  const maxRing = Math.max(1, Math.round(POLARITY_BAND_KM / spacingKm));
  sumAge.fill(0);
  cntAge.fill(0);
  for (let head = 0; head < tail; head++) {
    const c = queue[head];
    const t = top[c];
    if (wCrust[c] === CRUST_OCEANIC) {
      sumAge[t] += sc.wAge[c];
      cntAge[t]++;
    }
    const r = ring[c];
    if (r >= maxRing) continue;
    for (let q = adjOffset[c], e = adjOffset[c + 1]; q < e; q++) {
      const a = adj[q];
      if (ring[a] >= 0 || top[a] !== t) continue;
      ring[a] = r + 1;
      queue[tail++] = a;
    }
  }
  scores.fill(0);
  for (let k = 0; k < MAX_PLATES; k++) {
    const P = slots[k];
    if (!P) continue;
    const meanAge = cntAge[k] > 0 ? sumAge[k] / cntAge[k] : POLARITY_DEFAULT_AGE;
    const contDominated = P.visible > 0 && P.visibleCont >= 0.5 * P.visible;
    // Tiny deterministic tie-breaks: larger plates slightly more buoyant, then lower slot.
    scores[k] = (contDominated ? CONTINENTAL_RANK_BONUS : 0) - meanAge + 1e-7 * P.visible - 1e-9 * k;
  }
  return scores;
}

/** Initial total order of plates by buoyancy score (no hysteresis). */
export function initPolarity(state: SimState): void {
  const s = computeScores(state);
  state.rankOrder = liveSlotList(state).sort((a, b) => s[a] - s[b]);
  state.flipClock.fill(0);
  refreshRankPositions(state);
}

/**
 * F. Every POLARITY_INTERVAL Myr, one bubble pass over the rank order with hysteresis: adjacent
 * plates swap only after the lower one has been more buoyant by > POLARITY_FLIP_DIFF for
 * ≥ POLARITY_FLIP_TIME Myr. A per-plate total order has no cycles at triple junctions and no
 * per-cell polarity zippers.
 */
export function updatePolarity(state: SimState, dt: number): void {
  state.polarityClock += dt;
  if (state.polarityClock < POLARITY_INTERVAL) return;
  const elapsed = state.polarityClock;
  state.polarityClock = 0;
  const s = computeScores(state);
  const order = state.rankOrder;
  for (let p = 0; p + 1 < order.length; p++) {
    const lo = order[p], hi = order[p + 1];
    const idx = lo * MAX_PLATES + hi;
    if (s[lo] - s[hi] > POLARITY_FLIP_DIFF) {
      state.flipClock[idx] += elapsed;
      if (state.flipClock[idx] >= POLARITY_FLIP_TIME) {
        order[p] = hi;
        order[p + 1] = lo;
        state.flipClock[idx] = 0;
      }
    } else {
      state.flipClock[idx] = 0;
    }
  }
  refreshRankPositions(state);
}

/** Insert a new plate directly above `parent` in the rank order. */
export function insertRankAbove(state: SimState, child: PlateSlot, parent: number): void {
  const idx = state.rankOrder.indexOf(parent);
  if (idx < 0) state.rankOrder.push(child.slot);
  else state.rankOrder.splice(idx + 1, 0, child.slot);
  refreshRankPositions(state);
}

/** Insert a new plate directly below `parent` in the rank order. */
export function insertRankBelow(state: SimState, child: PlateSlot, parent: number): void {
  const idx = state.rankOrder.indexOf(parent);
  if (idx < 0) state.rankOrder.unshift(child.slot);
  else state.rankOrder.splice(idx, 0, child.slot);
  refreshRankPositions(state);
}
