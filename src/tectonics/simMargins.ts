import { CRUST_CONTINENTAL } from '../core/types';
import {
  MARGIN_COLUMN_M, MARGIN_INTERVAL, MARGIN_MAX_BACKLOG, SHELF_DEPTH, TRAPPED_BASIN_MAX_FRACTION, TRAPPED_BASIN_MIN_AGE,
} from './simConstants';
import { hash01 } from './simHash';
import type { PlateSlot, SimState } from './simState';

/** Salt separating the margin-sampling draws from other per-cell random draws of the same step. */
const MARGIN_SALT = 0x3a7c_91d5;

interface MarginScratch {
  /** Candidate cells bucketed by their number of continental same-plate neighbours (2..8+). */
  buckets: Int32Array[];
  counts: Int32Array;
}
const scratchOf = new WeakMap<SimState, MarginScratch>();
const MAX_COUNT = 8;

/**
 * Continental volume closure (see SEDIMENT_EFFICIENCY): every MARGIN_INTERVAL Myr the accumulated
 * eroded continental volume builds new continental shelf on passive margins — oceanic cells inside a
 * plate (no other plate in their ring) that touch at least two continental cells of the same plate,
 * embayments (most continental neighbours) first, so coastlines are smoothed rather than roughened.
 * Each new cell costs MARGIN_COLUMN_M of eroded elevation-equivalent and starts as shelf (≥ SHELF_DEPTH)
 * with its neighbours' mean crust age. Requires current world tops (any time after the substeps).
 */
export function accreteMargins(state: SimState, dt: number): void {
  state.marginClock += dt;
  if (state.marginClock < MARGIN_INTERVAL) return;
  state.marginClock = 0;
  fillTrappedBasins(state);
  state.sediment = Math.min(state.sediment, MARGIN_MAX_BACKLOG * state.n * MARGIN_COLUMN_M);
  let budget = Math.floor(state.sediment / MARGIN_COLUMN_M);
  if (budget <= 0) return;
  const { n, top, src, slots, counters } = state;
  const { adjOffset, adj } = state.sm;
  let sc = scratchOf.get(state);
  if (!sc) {
    sc = { buckets: [], counts: new Int32Array(MAX_COUNT + 1) };
    for (let c = 0; c <= MAX_COUNT; c++) sc.buckets.push(new Int32Array(64));
    scratchOf.set(state, sc);
  }
  const { buckets, counts } = sc;
  counts.fill(0);
  for (let i = 0; i < n; i++) {
    const t = top[i];
    const P = slots[t] as PlateSlot;
    if (P.crust[src[i]] === CRUST_CONTINENTAL) continue;
    let cont = 0, inside = true;
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
      const a = adj[q];
      if (top[a] !== t) {
        inside = false;
        break;
      }
      if (P.crust[src[a]] === CRUST_CONTINENTAL) cont++;
    }
    if (!inside || cont < 2) continue;
    const c = Math.min(MAX_COUNT, cont);
    if (counts[c] === buckets[c].length) {
      const grown = new Int32Array(2 * buckets[c].length);
      grown.set(buckets[c]);
      buckets[c] = grown;
    }
    buckets[c][counts[c]++] = i;
  }
  const seed = state.params.seed ^ MARGIN_SALT, step = state.stepIndex;
  for (let c = MAX_COUNT; c >= 2 && budget > 0; c--) {
    const list = buckets[c];
    const cntC = counts[c];
    // The bucket that exhausts the budget is sampled uniformly (selection sampling, per-cell hashes):
    // cell indices are spatially coherent (SimMesh), so taking it in index order would feed the
    // margins of the same part of the sphere every time.
    const sample = cntC > budget;
    for (let r = 0; r < cntC && budget > 0; r++) {
      const i = list[r];
      if (sample && !(hash01(seed, step, i, c) * (cntC - r) < budget)) continue;
      const P = slots[top[i]] as PlateSlot;
      const j = src[i];
      if (P.crust[j] === CRUST_CONTINENTAL) continue;
      let sumAge = 0, cnt = 0;
      for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
        const ja = src[adj[q]];
        if (P.crust[ja] !== CRUST_CONTINENTAL) continue;
        sumAge += P.age[ja];
        cnt++;
      }
      P.crust[j] = CRUST_CONTINENTAL;
      if (P.elev[j] < SHELF_DEPTH) P.elev[j] = SHELF_DEPTH;
      P.age[j] = cnt > 0 ? sumAge / cnt : 0;
      P.orogeny[j] = 0;
      budget--;
      state.sediment -= MARGIN_COLUMN_M;
      counters.continentalCreated++;
      counters.marginAccretions++;
    }
  }
}

interface BasinScratch {
  comp: Int32Array;
  queue: Int32Array;
  cells: Int32Array;
}
const basinOf = new WeakMap<SimState, BasinScratch>();

/**
 * Trapped ocean basins (Black Sea / Caspian style remnants enclosed by continents after collisions,
 * with no ridge left inside) fill with the sediment of their surroundings: every MARGIN_INTERVAL the
 * outermost ring of each such basin (oceanic world components other than the largest one, inside a
 * single plate, at most
 * TRAPPED_BASIN_MAX_FRACTION of the sphere, youngest crust older than TRAPPED_BASIN_MIN_AGE) becomes
 * continental shelf. Without this, old closed seas accumulate and continents look moth-eaten after
 * a few Wilson cycles.
 */
function fillTrappedBasins(state: SimState): void {
  const { n, top, src, slots, counters } = state;
  const { adjOffset, adj } = state.sm;
  let sc = basinOf.get(state);
  if (!sc) {
    sc = { comp: new Int32Array(n), queue: new Int32Array(n), cells: new Int32Array(n) };
    basinOf.set(state, sc);
  }
  const { comp, queue } = sc;
  const crustAt = (i: number): number => (slots[top[i]] as PlateSlot).crust[src[i]];
  comp.fill(-1);
  // Label oceanic components; remember each one's size and youngest crust.
  const sizes: number[] = [];
  const minAge: number[] = [];
  const onePlate: boolean[] = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0 || crustAt(i) === CRUST_CONTINENTAL) continue;
    const id = sizes.length;
    let tail = 0, size = 0, youngest = Infinity, single = true;
    comp[i] = id;
    queue[tail++] = i;
    for (let head = 0; head < tail; head++) {
      const c = queue[head];
      size++;
      const a0 = (slots[top[c]] as PlateSlot).age[src[c]];
      if (a0 < youngest) youngest = a0;
      if (top[c] !== top[i]) single = false;
      for (let q = adjOffset[c], e = adjOffset[c + 1]; q < e; q++) {
        const a = adj[q];
        if (comp[a] >= 0 || crustAt(a) === CRUST_CONTINENTAL) continue;
        comp[a] = id;
        queue[tail++] = a;
      }
    }
    sizes.push(size);
    minAge.push(youngest);
    onePlate.push(single);
  }
  if (sizes.length < 2) return;
  let largest = 0;
  for (let k = 1; k < sizes.length; k++) if (sizes[k] > sizes[largest]) largest = k;
  const maxSize = TRAPPED_BASIN_MAX_FRACTION * n;
  // Only remnants inside one plate: a sea between plates still has an active boundary (and in
  // continent-rich worlds most of the ocean is split into such seas).
  const fill = sizes.map((size, k) => k !== largest && onePlate[k] && size <= maxSize && minAge[k] >= TRAPPED_BASIN_MIN_AGE);
  // Outer ring first (decided before converting anything, so a basin shrinks by one ring per call).
  let count = 0;
  const ring = sc.cells;
  for (let i = 0; i < n; i++) {
    const k = comp[i];
    if (k < 0 || !fill[k]) continue;
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
      if (crustAt(adj[q]) === CRUST_CONTINENTAL) {
        ring[count++] = i;
        break;
      }
    }
  }
  for (let r = 0; r < count; r++) {
    const i = ring[r];
    const P = slots[top[i]] as PlateSlot;
    const j = src[i];
    if (P.crust[j] === CRUST_CONTINENTAL) continue;
    let sumAge = 0, cnt = 0;
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
      const a = adj[q];
      const Q = slots[top[a]] as PlateSlot;
      if (Q.crust[src[a]] !== CRUST_CONTINENTAL) continue;
      sumAge += Q.age[src[a]];
      cnt++;
    }
    P.crust[j] = CRUST_CONTINENTAL;
    if (P.elev[j] < SHELF_DEPTH) P.elev[j] = SHELF_DEPTH;
    P.age[j] = cnt > 0 ? sumAge / cnt : P.age[j];
    P.orogeny[j] = 0;
    counters.continentalCreated++;
    counters.basinClosures++;
  }
}
